// worker/lib/autopilot.js
// Everything that keeps the engine running without a human:
//
//   • daily schedule   - the worker (not Vercel) fires the run, in YOUR timezone
//   • crash recovery   - jobs left mid-flight by a reboot are re-queued on start
//   • automatic retry  - a failed run is retried with a growing back-off
//
// The worker is the only always-on component, so it owns all three. Vercel's
// cron stays as a backup for the case where the PC is asleep: both sides claim
// the same "autopilot:fired:<date>" key, so a day can only ever fire once.

const {
  getSchedule, getConfig, createJob, enqueueJob, claim, listRecentJobIds,
  getJob, updateJob, scheduleRetry, dueRetries, client,
} = require('./store');

// How long a running job may go without a progress write before we assume the
// worker died mid-song and re-queue it.
const STALE_MS = 15 * 60 * 1000;
// Back-off between automatic retries.
const RETRY_DELAYS_MS = [3 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000];

/** Wall-clock parts in the configured timezone (falls back to UTC). */
function localNow(timezone) {
  const d = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour) % 24,
      minute: Number(parts.minute),
    };
  } catch (_) {
    return {
      date: d.toISOString().slice(0, 10),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }
}

/** Human-readable "next run" for the dashboard. */
function nextRunLabel(schedule, timezone) {
  if (!schedule.enabled) return null;
  const now = localNow(timezone);
  const hh = String(schedule.hour).padStart(2, '0');
  const mm = String(schedule.minute).padStart(2, '0');
  const past = now.hour > schedule.hour || (now.hour === schedule.hour && now.minute >= schedule.minute);
  return `${past ? 'tomorrow' : 'today'} ${hh}:${mm}`;
}

/** Fire the daily run, at most once per calendar day in the user's timezone. */
async function maybeFireDaily() {
  const schedule = await getSchedule();
  if (!schedule.enabled) return null;
  const cfg = await getConfig();
  const now = localNow(cfg.timezone);

  // A two-minute window absorbs a slow tick or a brief Redis hiccup; the claim
  // below is what actually guarantees a single run.
  const due = now.hour === schedule.hour && now.minute >= schedule.minute && now.minute <= schedule.minute + 2;
  if (!due) return null;

  const got = await claim(`autopilot:fired:${now.date}`, 22 * 3600);
  if (!got) return null;

  const n = Math.max(1, cfg.songsPerDay || 1);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const job = await createJob({ trigger: 'autopilot' });
    await enqueueJob(job.id);
    ids.push(job.id);
  }
  console.log(`[autopilot] ${now.date} ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} — queued ${n} song(s)`);
  return ids;
}

/** Move every retry whose time has come back onto the work queue. */
async function drainRetries() {
  const ids = await dueRetries();
  for (const id of ids) {
    const job = await getJob(id);
    if (!job || job.status === 'done') continue;
    await updateJob(id, {
      status: 'queued',
      note: `Retrying automatically (attempt ${(job.attempt || 1) + 1})…`,
      nextRetryAt: null,
    });
    await enqueueJob(id);
    console.log(`[autopilot] retrying job ${id}`);
  }
  return ids.length;
}

/**
 * Decide what happens after a failed run. Returns true when a retry was
 * scheduled, false when the job is left failed for the user to look at.
 */
async function handleFailure(jobId) {
  const cfg = await getConfig();
  const job = await getJob(jobId);
  if (!job) return false;

  const attempt = job.attempt || 1;
  const max = (cfg.autoRetries || 0) + 1; // attempts, not extra tries
  if (attempt >= max) {
    await updateJob(jobId, { note: `Failed after ${attempt} attempt(s)`, nextRetryAt: null });
    return false;
  }

  const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
  const at = Date.now() + delay;
  await updateJob(jobId, {
    attempt: attempt + 1,
    maxAttempts: max,
    nextRetryAt: new Date(at).toISOString(),
    note: `Retrying automatically in ${Math.round(delay / 60000)} min (attempt ${attempt + 1}/${max})`,
  });
  await scheduleRetry(jobId, at);
  console.log(`[autopilot] job ${jobId} failed — retry ${attempt + 1}/${max} in ${Math.round(delay / 60000)} min`);
  return true;
}

/**
 * Startup recovery: a PC that was shut down mid-song leaves a job stuck in
 * "running", and a job enqueued while the worker was off can be lost if Redis
 * was flushed. Put both back on the queue.
 */
async function recoverStuckJobs() {
  let queued = [];
  try {
    queued = (await client.lrange('jobs:queue', 0, -1)).map((v) => {
      try { return JSON.parse(v); } catch (_) { return v; }
    });
  } catch (_) {}

  const ids = await listRecentJobIds(30);
  let recovered = 0;
  for (const id of ids) {
    const job = await getJob(id);
    if (!job) continue;
    if (queued.includes(id)) continue;

    const age = Date.now() - new Date(job.updatedAt || job.createdAt).getTime();
    const stuckRunning = job.status === 'running' && age > STALE_MS;
    const orphanQueued = job.status === 'queued' && age > 60 * 1000;
    if (!stuckRunning && !orphanQueued) continue;

    await updateJob(id, {
      status: 'queued',
      note: stuckRunning ? 'Worker restarted — picking this up again…' : 'Picked up after the worker came back…',
      attempt: (job.attempt || 1),
    });
    await enqueueJob(id);
    recovered++;
  }
  if (recovered) console.log(`[autopilot] recovered ${recovered} unfinished job(s)`);
  return recovered;
}

/** Status block for the heartbeat, so the dashboard can show the autopilot. */
async function status() {
  try {
    const [schedule, cfg] = await Promise.all([getSchedule(), getConfig()]);
    return {
      enabled: Boolean(schedule.enabled),
      at: `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`,
      timezone: cfg.timezone || 'UTC',
      songsPerDay: cfg.songsPerDay || 1,
      nextRun: nextRunLabel(schedule, cfg.timezone),
      videoMode: cfg.videoMode || 'auto',
      autoRetries: cfg.autoRetries || 0,
      localSave: Boolean(cfg.localSavePath),
    };
  } catch (_) {
    return null;
  }
}

/** Run the timers. Called once from server.js. */
function start({ intervalMs = 30000 } = {}) {
  const tick = async () => {
    try { await drainRetries(); } catch (e) { console.warn(`[autopilot] retry drain: ${e.message}`); }
    try { await maybeFireDaily(); } catch (e) { console.warn(`[autopilot] schedule: ${e.message}`); }
  };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, status, handleFailure, recoverStuckJobs, drainRetries, maybeFireDaily, localNow };
