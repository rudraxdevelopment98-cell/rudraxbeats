// worker/lib/llm.js
// One text-generation call, from whichever provider the Lyrics stage is set to.
//
//   gemini  - Google's free tier. Uses the Gemini key that already exists for
//             the cover art, so there is nothing extra to sign up for.
//   openai  - api.openai.com, or ANY OpenAI-compatible endpoint (Groq,
//             OpenRouter, Together…) by changing the base URL.
//
// The web app has a mirror of this in web/lib/llmChat.js - keep them in sync.

// Overridable so the provider logic can be exercised against a stub.
const GEMINI_ROOT = process.env.GEMINI_API_ROOT || 'https://generativelanguage.googleapis.com/v1beta';

// Model ids move around; try the current ones and keep whichever answers.
const GEMINI_TEXT_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.0-flash-lite',
];

// This model id is wrong/retired - another one may work.
const isModelProblem = (msg) =>
  /\b404\b|not found|NOT_FOUND|is not supported|does not support/i.test(String(msg));

// The model is fine but busy right now. Worth waiting a moment and retrying,
// and worth trying a sibling model - Google's capacity varies per model.
const isBusy = (msg) =>
  /\b(429|500|502|503|504)\b|UNAVAILABLE|INTERNAL|overloaded|high demand|RESOURCE_EXHAUSTED|no answer within/i.test(
    String(msg)
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A provider that accepts the connection and then stalls is the worst case:
// without this, one hung request burns the whole serverless budget and the
// browser gets Vercel's HTML timeout page instead of a JSON answer.
async function fetchWithTimeout(url, init, timeoutMs) {
  const ms = timeoutMs || 60000;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`no answer within ${Math.round(ms / 1000)}s (the model is busy)`);
    }
    throw e;
  }
}

/** Which provider a config is set to, and whether it can actually run. */
function lyricsProvider(cfg) {
  const p = (cfg.lyricsProvider || 'gemini').toLowerCase();
  return p === 'openai' ? 'openai' : 'gemini';
}

function lyricsReady(cfg) {
  return lyricsProvider(cfg) === 'openai' ? Boolean(cfg.openaiApiKey) : Boolean(cfg.geminiApiKey);
}

async function geminiOnce(cfg, model, req, noThinking = true) {
  const { system, user, json, maxTokens } = req;
  const res = await fetchWithTimeout(`${GEMINI_ROOT}/models/${model}:generateContent?key=${cfg.geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: maxTokens || 4096,
        // Gemini 2.5 "thinks" before answering and that reasoning is billed to
        // the SAME output budget, so a song can come back as a truncated
        // fragment. We want lyrics, not deliberation - turn it off.
        ...(noThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  }, req.timeoutMs);
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    // Older models reject thinkingConfig outright; retry without it.
    if (noThinking && /thinking/i.test(b)) return geminiOnce(cfg, model, req, false);
    throw new Error(`Gemini text failed (${res.status}) on ${model}: ${b.slice(0, 250)}`);
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) {
    const why = cand?.finishReason || data?.promptFeedback?.blockReason || 'empty answer';
    throw new Error(`Gemini returned no text from ${model} (${why})`);
  }
  // A cut-off answer is worse than no answer: it silently produces half a song.
  if (cand?.finishReason === 'MAX_TOKENS') {
    throw new Error(`Gemini ran out of output room on ${model} - raise maxOutputTokens`);
  }
  return { text, model, usage: data?.usageMetadata?.totalTokenCount };
}

/**
 * @param {object} cfg resolved config
 * @param {{system?:string, user:string, json?:boolean, maxTokens?:number}} req
 * @returns {Promise<{text:string, model:string, usage?:number}>}
 */
async function chat(cfg, req) {
  if (lyricsProvider(cfg) === 'gemini') {
    if (!cfg.geminiApiKey) throw new Error('Gemini API key is not set (Pipeline → Lyrics)');
    const tried = [];
    const candidates = [cfg.geminiTextModel, ...GEMINI_TEXT_MODELS].filter(
      (m) => m && !tried.includes(m) && (tried.push(m) || true)
    );
    // Callers on a clock (a serverless request) can cap the whole search.
    const started = Date.now();
    const outOfTime = () => req.deadlineMs && Date.now() - started > req.deadlineMs;
    // As the budget runs down, give each remaining call only the time that is
    // actually left - otherwise the last attempt overruns the whole deadline.
    const attemptReq = () => {
      if (!req.deadlineMs) return req;
      const left = req.deadlineMs - (Date.now() - started);
      return { ...req, timeoutMs: Math.max(2000, Math.min(req.timeoutMs || 60000, left)) };
    };

    let lastErr = null;
    for (const model of candidates) {
      // Two goes at each model: a busy model is usually fine a second later.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (outOfTime() && lastErr) throw lastErr;
        try {
          return await geminiOnce(cfg, model, attemptReq());
        } catch (e) {
          lastErr = e;
          const busy = isBusy(e.message);
          // A bad key, a blocked prompt or an answer that ran out of room
          // won't be fixed by waiting or by another model.
          if (!busy && !isModelProblem(e.message)) throw e;
          if (!busy) break;               // wrong model id - go to the next one
          if (outOfTime()) throw lastErr;
          if (attempt === 0) await sleep(1500);
        }
      }
      if (outOfTime()) throw lastErr;
    }
    throw lastErr || new Error('Gemini text failed');
  }

  if (!cfg.openaiApiKey) throw new Error('OpenAI API key is not set (Pipeline → Lyrics)');
  const base = (cfg.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = cfg.openaiModel || 'gpt-4o-mini';
  const res = await fetchWithTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiApiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.user },
      ],
    }),
  }, req.timeoutMs);
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`OpenAI failed (${res.status}): ${b.slice(0, 250)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI answered but wrote nothing');
  return { text, model, usage: data?.usage?.total_tokens };
}

module.exports = { chat, lyricsProvider, lyricsReady, GEMINI_TEXT_MODELS };
