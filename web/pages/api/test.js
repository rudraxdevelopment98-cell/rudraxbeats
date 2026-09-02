// pages/api/test.js
// GET ?target=openai|suno|gemini|worker  (auth-guarded)
// Lightweight connectivity/credential checks so the Settings page can tell
// the user whether each value actually works. Returns { ok, message }.

import { requireAuth } from '../../lib/auth.js';
import { getConfig } from '../../lib/config.js';

async function testOpenAI(c) {
  if (!c.openaiApiKey) return { ok: false, message: 'No OpenAI key set.' };
  const r = await fetch(`${c.openaiBaseUrl || 'https://api.openai.com/v1'}/models`, {
    headers: { Authorization: `Bearer ${c.openaiApiKey}` },
  });
  if (r.ok) return { ok: true, message: 'OpenAI key works ✓' };
  return { ok: false, message: `OpenAI rejected the key (${r.status}).` };
}

async function testGemini(c) {
  if (!c.geminiApiKey) return { ok: false, message: 'No Gemini key set.' };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${c.geminiApiKey}`);
  if (r.ok) return { ok: true, message: 'Gemini key works ✓' };
  return { ok: false, message: `Gemini rejected the key (${r.status}).` };
}

async function testSuno(c) {
  const base = (c.sunoBaseUrl || '').replace(/\/$/, '');
  if (!base) return { ok: false, message: 'No Suno wrapper URL set.' };
  if ((c.sunoMode || 'suno-api') === 'suno-api') {
    // gcui-art/suno-api exposes /api/get_limit with your remaining credits.
    try {
      const r = await fetch(`${base}/api/get_limit`, {
        headers: c.sunoApiKey ? { Authorization: `Bearer ${c.sunoApiKey}` } : {},
      });
      if (!r.ok) return { ok: false, message: `Wrapper returned ${r.status}. Is SUNO_COOKIE valid?` };
      const d = await r.json().catch(() => ({}));
      const credits = d.credits_left ?? d.credits ?? d.remaining ?? null;
      return { ok: true, message: credits != null ? `Connected ✓ (credits left: ${credits})` : 'Wrapper reachable ✓' };
    } catch (e) {
      return { ok: false, message: `Cannot reach wrapper: ${e.message}` };
    }
  }
  // generic mode: just check the base URL responds
  try {
    const r = await fetch(base);
    return { ok: r.ok, message: r.ok ? 'Reachable ✓' : `Returned ${r.status}` };
  } catch (e) {
    return { ok: false, message: `Cannot reach: ${e.message}` };
  }
}

async function testWorker(c) {
  if (!c.workerUrl) return { ok: false, message: 'No worker URL set.' };
  try {
    const r = await fetch(`${c.workerUrl.replace(/\/$/, '')}/health`);
    if (r.ok) return { ok: true, message: 'Worker is up ✓' };
    return { ok: false, message: `Worker returned ${r.status}.` };
  } catch (e) {
    return { ok: false, message: `Cannot reach worker: ${e.message}` };
  }
}

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  try {
    const c = await getConfig();
    const target = String(req.query.target || '');
    const fn = { openai: testOpenAI, gemini: testGemini, suno: testSuno, worker: testWorker }[target];
    if (!fn) return res.status(400).json({ error: 'Unknown target' });
    const result = await fn(c);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(200).json({ ok: false, message: err.message });
  }
}
