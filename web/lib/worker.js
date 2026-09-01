// lib/worker.js
// renderVideo() - calls the separate always-on worker service's POST /render
// endpoint (Railway/Render) which does the heavy ffmpeg work and returns a
// public mp4 URL. Authenticated with the shared WORKER_SECRET bearer token.

import { getConfig } from './config.js';

// ffmpeg rendering can take a while; give the request a generous timeout.
const RENDER_TIMEOUT_MS = 1000 * 60 * 8;

/**
 * @param {object} args
 * @param {string} args.audioUrl        public URL of the generated song
 * @param {string} args.title           song title (for subtitle/overlay)
 * @param {string} args.thumbnailBase64 base64 image (no data: prefix)
 * @param {number} [args.durationSec]   optional target duration
 * @returns {Promise<{videoUrl:string, durationSec:number|null, raw:object}>}
 */
export async function renderVideo({ audioUrl, title, thumbnailBase64, durationSec }) {
  const cfg = await getConfig();
  const WORKER_URL = cfg.workerUrl;
  const WORKER_SECRET = cfg.workerSecret;
  if (!WORKER_URL) throw new Error('Worker URL is not set (Settings > Video worker)');
  if (!WORKER_SECRET) throw new Error('Worker secret is not set (Settings > Video worker)');
  if (!audioUrl) throw new Error('renderVideo: audioUrl is required');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/render`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_SECRET}`,
      },
      body: JSON.stringify({ audioUrl, title, thumbnailBase64, durationSec }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('Video worker render timed out');
    }
    throw new Error(`Video worker unreachable: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Video worker /render failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  if (!data.videoUrl) {
    throw new Error(`Video worker returned no videoUrl: ${JSON.stringify(data).slice(0, 400)}`);
  }

  return {
    videoUrl: data.videoUrl,
    durationSec: data.durationSec ?? null,
    raw: data,
  };
}
