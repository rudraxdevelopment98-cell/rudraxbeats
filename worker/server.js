// worker/server.js
// Always-on worker. Two jobs:
//   1. HTTP: /health (uptime checks) and /render (legacy direct render call)
//   2. Queue loop: BRPOP jobs from Redis and run the full pipeline for each,
//      writing live progress back to Redis for the dashboard.
//
// This is what makes "one click" and the daily schedule actually work: Vercel
// only enqueues, and all the multi-minute work happens here with no timeout.

const express = require('express');

const { popQueue, getJob, updateJob, client } = require('./lib/store');
const { runJob } = require('./lib/pipeline');
const { ffmpegPath, HAS_DRAWTEXT } = require('./lib/video');

const PORT = process.env.PORT || 3001;

const state = {
  startedAt: new Date().toISOString(),
  processed: 0,
  failed: 0,
  current: null,
  lastError: null,
};

// ---------------------------------------------------------------- http ----
const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/', (_req, res) => res.json({ ok: true, service: 'ai-song-engine-worker', ...state }));
app.get('/health', (_req, res) => res.json({ ok: true, ...state }));

app.listen(PORT, () => {
  console.log(`ai-song-engine worker listening on :${PORT}`);
  console.log(`ffmpeg: ${ffmpegPath} (drawtext: ${HAS_DRAWTEXT ? 'yes' : 'no'})`);
  console.log('waiting for jobs on the "jobs:queue" list…');
});

// --------------------------------------------------------------- queue ----
async function loop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let jobId = null;
    try {
      jobId = await popQueue(5); // blocks up to 5s, then loops again
    } catch (e) {
      console.error('queue pop error:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!jobId) continue;

    const job = await getJob(jobId).catch(() => null);
    if (!job) {
      console.warn(`job ${jobId} not found, skipping`);
      continue;
    }
    if (job.status === 'done') continue; // already finished elsewhere

    state.current = jobId;
    console.log(`--- picking up job ${jobId} ---`);
    try {
      const result = await runJob(jobId);
      if (result) state.processed++;
      else state.failed++;
    } catch (e) {
      state.failed++;
      state.lastError = e.message;
      console.error(`job ${jobId} crashed:`, e);
      await updateJob(jobId, {
        status: 'error',
        error: `worker: ${e.message}`,
        note: 'Worker error',
      }).catch(() => {});
    } finally {
      state.current = null;
    }
  }
}

loop().catch((e) => {
  console.error('queue loop died:', e);
  process.exit(1);
});

// Graceful shutdown so a redeploy doesn't leave a job half-written.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`${sig} received, shutting down…`);
    try { await client.quit(); } catch (_) {}
    process.exit(0);
  });
}
