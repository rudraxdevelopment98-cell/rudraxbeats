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
  'gemini-2.0-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
];

const isModelProblem = (msg) =>
  /\b404\b|not found|NOT_FOUND|is not supported|does not support/i.test(String(msg));

/** Which provider a config is set to, and whether it can actually run. */
function lyricsProvider(cfg) {
  const p = (cfg.lyricsProvider || 'gemini').toLowerCase();
  return p === 'openai' ? 'openai' : 'gemini';
}

function lyricsReady(cfg) {
  return lyricsProvider(cfg) === 'openai' ? Boolean(cfg.openaiApiKey) : Boolean(cfg.geminiApiKey);
}

async function geminiOnce(cfg, model, { system, user, json, maxTokens }) {
  const res = await fetch(`${GEMINI_ROOT}/models/${model}:generateContent?key=${cfg.geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: maxTokens || 2048,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`Gemini text failed (${res.status}) on ${model}: ${b.slice(0, 250)}`);
  }
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) {
    const why = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'empty answer';
    throw new Error(`Gemini returned no text from ${model} (${why})`);
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
    let lastErr = null;
    for (const model of candidates) {
      try {
        return await geminiOnce(cfg, model, req);
      } catch (e) {
        lastErr = e;
        if (!isModelProblem(e.message)) throw e; // quota, bad key, blocked prompt
      }
    }
    throw lastErr || new Error('Gemini text failed');
  }

  if (!cfg.openaiApiKey) throw new Error('OpenAI API key is not set (Pipeline → Lyrics)');
  const base = (cfg.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = cfg.openaiModel || 'gpt-4o-mini';
  const res = await fetch(`${base}/chat/completions`, {
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
  });
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
