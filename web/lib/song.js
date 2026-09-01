// lib/song.js
// generateSong() - submits a generation job to a third-party Suno API
// wrapper and polls until an audio URL is ready.
//
// IMPORTANT: Suno has no official public API (as of 2026). These are all
// unofficial wrappers (Apiframe / MusicAPI / Crazyrouter / SunoAPI.org etc).
// They differ in paths and field names, so this module is deliberately
// generic and configurable via env vars. Defaults follow the common
// submit -> poll(status) pattern. Adjust the *_PATH env vars and the field
// extractors below to match your chosen provider's docs.

import { getConfig } from './config.js';

const POLL_INTERVAL_MS = 6000;
const MAX_POLLS = 60; // ~6 min ceiling

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

// Providers nest the audio URL under many possible keys. Search common ones.
function extractAudioUrl(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.audio_url, obj.audioUrl, obj.audio, obj.mp3_url, obj.url,
    obj.data?.audio_url, obj.data?.audioUrl,
    obj.output?.audio_url, obj.output?.[0]?.audio_url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('http')) return c;
  }
  // Deep search for the first http(s) mp3/audio-looking url.
  const seen = new Set();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const v of Object.values(cur)) {
      if (typeof v === 'string' && /^https?:\/\/.+\.(mp3|wav|m4a|ogg)/i.test(v)) return v;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

function extractJobId(obj) {
  const candidates = [
    obj?.id, obj?.job_id, obj?.jobId, obj?.task_id, obj?.taskId,
    obj?.data?.id, obj?.data?.task_id, obj?.data?.[0]?.id,
  ];
  for (const c of candidates) {
    if (c != null) return String(c);
  }
  return null;
}

function extractStatus(obj) {
  const s = obj?.status || obj?.state || obj?.data?.status || obj?.data?.[0]?.status;
  return s ? String(s).toLowerCase() : null;
}

/**
 * @param {object} args
 * @param {string} args.title
 * @param {string} args.lyrics
 * @param {string} args.style_tags
 * @param {(msg:string)=>void} [onProgress]
 * @returns {Promise<{audioUrl:string, providerJobId:string|null, raw:object}>}
 */
export async function generateSong({ title, lyrics, style_tags }, onProgress = () => {}) {
  const cfg = await getConfig();
  const BASE_URL = cfg.sunoBaseUrl;
  const API_KEY = cfg.sunoApiKey;
  const SUBMIT_PATH = cfg.sunoSubmitPath || '/api/generate';
  const STATUS_PATH = cfg.sunoStatusPath || '/api/status';
  const MODEL = cfg.sunoModel || 'chirp-v3-5';
  if (!BASE_URL || !API_KEY) {
    throw new Error('Suno provider URL/key not set (Settings > Song)');
  }

  // 1) Submit. This body covers the most common wrapper shapes; tweak to
  //    your provider if needed.
  const submitBody = {
    model: MODEL,
    custom_mode: true,
    make_instrumental: false,
    prompt: lyrics,
    lyrics,
    title,
    tags: style_tags,
    style: style_tags,
    wait_audio: false,
  };

  const submitRes = await fetch(`${BASE_URL}${SUBMIT_PATH}`, {
    method: 'POST',
    headers: authHeaders(API_KEY),
    body: JSON.stringify(submitBody),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text().catch(() => '');
    throw new Error(`Suno submit failed (${submitRes.status}): ${body.slice(0, 500)}`);
  }

  const submitJson = await submitRes.json();

  // Some providers return the audio URL synchronously.
  let audioUrl = extractAudioUrl(submitJson);
  const providerJobId = extractJobId(submitJson);

  if (audioUrl) {
    onProgress('song ready (sync)');
    return { audioUrl, providerJobId, raw: submitJson };
  }

  if (!providerJobId) {
    throw new Error(
      'Suno submit returned neither an audio URL nor a job id. ' +
        'Check SUNO_SUBMIT_PATH and the response shape for your provider. ' +
        `Response: ${JSON.stringify(submitJson).slice(0, 500)}`
    );
  }

  // 2) Poll status.
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);

    const statusUrl = `${BASE_URL}${STATUS_PATH}${STATUS_PATH.includes('?') ? '&' : '?'}id=${encodeURIComponent(providerJobId)}`;
    const statusRes = await fetch(statusUrl, { headers: authHeaders(API_KEY) });

    if (!statusRes.ok) {
      // transient error - keep polling a few times before giving up
      onProgress(`status check ${i + 1} returned ${statusRes.status}, retrying`);
      continue;
    }

    const statusJson = await statusRes.json();
    audioUrl = extractAudioUrl(statusJson);
    const status = extractStatus(statusJson);
    onProgress(`poll ${i + 1}/${MAX_POLLS} status=${status || 'unknown'}`);

    if (audioUrl) {
      return { audioUrl, providerJobId, raw: statusJson };
    }
    if (status && ['failed', 'error', 'cancelled'].includes(status)) {
      throw new Error(`Suno generation ${status}: ${JSON.stringify(statusJson).slice(0, 400)}`);
    }
  }

  throw new Error('Suno generation timed out before an audio URL was ready');
}
