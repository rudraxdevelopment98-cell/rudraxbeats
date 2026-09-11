// lib/geminiImage.js
// One Gemini image call with automatic model fallback.
//
// The worker has its own copy of this (worker/lib/steps.js) because it runs as
// a separate CommonJS app; keep the candidate list in the two files in sync.

const IMAGE_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-2.0-flash-exp-image-generation',
];

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/** Is this failure "wrong model id" (worth trying another) or something real? */
const isModelProblem = (msg) =>
  /\b404\b|not found|NOT_FOUND|is not supported|does not support|no image/i.test(String(msg));

async function once(apiKey, model, prompt) {
  const res = await fetch(`${API_ROOT}/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`Gemini image failed (${res.status}) on ${model}: ${b.slice(0, 200)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const p = parts.find((x) => x.inlineData?.data || x.inline_data?.data);
  const inline = p?.inlineData || p?.inline_data;
  if (!inline?.data) throw new Error(`Gemini returned no image from ${model}`);
  return { base64: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png', model };
}

/**
 * @returns {Promise<{base64:string, mimeType:string, model:string}>}
 */
export async function generateImage(apiKey, prompt, preferredModel = '') {
  if (!apiKey) throw new Error('Gemini API key is not set');
  const tried = [];
  const candidates = [preferredModel, ...IMAGE_MODELS].filter(
    (m) => m && !tried.includes(m) && (tried.push(m) || true)
  );
  let lastErr = null;
  for (const model of candidates) {
    try {
      return await once(apiKey, model, prompt);
    } catch (e) {
      lastErr = e;
      // A bad key, a quota problem or a blocked prompt won't be fixed by
      // another model - fail now instead of burning the whole list.
      if (!isModelProblem(e.message)) throw e;
    }
  }
  throw lastErr || new Error('Gemini image failed');
}

export { IMAGE_MODELS };
