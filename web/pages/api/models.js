// pages/api/models.js
// GET ?target=openai|gemini -> the models THIS key can actually use.
//
// Asking the provider beats shipping a hardcoded list: model ids get retired,
// and what a key may call depends on its project and region.

import { requireAuth } from '../../lib/auth.js';
import { getConfig } from '../../lib/config.js';

// Cheap, sensible defaults to highlight in the picker.
const RECOMMENDED = ['gpt-4o-mini', 'gpt-4.1-mini', 'gemini-2.5-flash-image'];

async function openaiModels(c) {
  if (!c.openaiApiKey) return { ok: false, message: 'Add the OpenAI key first.', models: [] };
  const base = (c.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${c.openaiApiKey}` } });
  if (!r.ok) return { ok: false, message: `OpenAI rejected the key (${r.status}).`, models: [] };
  const data = await r.json();
  const ids = (data.data || [])
    .map((m) => String(m.id || ''))
    // chat-capable families only: no embeddings, audio, image or moderation ids
    .filter((id) => /^(gpt-|o[0-9]|chatgpt-)/i.test(id))
    .filter((id) => !/(embed|whisper|tts|audio|image|realtime|moderation|transcribe|search|dall)/i.test(id))
    .sort();
  return {
    ok: true,
    message: `${ids.length} chat model(s) available on this key`,
    models: ids.map((id) => ({ id, recommended: RECOMMENDED.includes(id) })),
  };
}

async function geminiModels(c) {
  if (!c.geminiApiKey) return { ok: false, message: 'Add the Gemini key first.', models: [] };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${c.geminiApiKey}`);
  if (!r.ok) return { ok: false, message: `Gemini rejected the key (${r.status}).`, models: [] };
  const data = await r.json();
  const all = (data.models || []).filter((m) =>
    (m.supportedGenerationMethods || []).includes('generateContent')
  );
  // Only image-capable models are useful here - the cover art is an image.
  const images = all
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((n) => /image/i.test(n))
    .sort();
  if (!images.length) {
    return {
      ok: false,
      message:
        'This key has no image-capable model. Cover art and AI scenes would fall back to a plain gradient.',
      models: [],
    };
  }
  return {
    ok: true,
    message: `${images.length} image model(s) available on this key`,
    models: images.map((id) => ({ id, recommended: RECOMMENDED.includes(id) })),
  };
}

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  try {
    const c = await getConfig();
    const target = String(req.query.target || '');
    const fn = { openai: openaiModels, gemini: geminiModels }[target];
    if (!fn) return res.status(400).json({ error: 'Unknown target' });
    return res.status(200).json(await fn(c));
  } catch (err) {
    return res.status(200).json({ ok: false, message: err.message, models: [] });
  }
}
