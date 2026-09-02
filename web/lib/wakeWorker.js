// lib/wakeWorker.js
// Free hosting tiers (e.g. Render's free web service) spin the worker down
// after a period with no inbound HTTP. Enqueuing a job is a Redis write, which
// does NOT wake it - so we also fire a cheap HTTP request at the worker's
// /health endpoint. Best-effort: never blocks or fails the request.

import { getConfig } from './config.js';

export async function wakeWorker() {
  try {
    const cfg = await getConfig();
    if (!cfg.workerUrl) return { woken: false, reason: 'no worker URL' };
    const url = `${cfg.workerUrl.replace(/\/$/, '')}/health`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      return { woken: r.ok };
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    // A cold worker often times out on the first hit - that request still
    // triggers the spin-up, so this is not an error worth surfacing.
    return { woken: false, reason: e.message };
  }
}
