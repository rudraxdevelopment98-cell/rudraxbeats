// worker/lib/store.js
// Redis-backed store shared with the Vercel web app. Key layout must match
// web/lib/db.js exactly:
//   job:<id>     JSON job record
//   jobs:index   list of job ids (newest first)
//   jobs:queue   list of job ids waiting for this worker
//   config       JSON settings object (written by the dashboard)

const Redis = require('ioredis');

const REDIS_URL =
  process.env.REDIS_URL || process.env.KV_URL || process.env.REDIS_TCP_URL || '';

if (!REDIS_URL) {
  console.error('FATAL: REDIS_URL is not set. The worker needs the same Redis as the web app.');
}

const client = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null, // keep retrying; this is a long-lived process
  enableReadyCheck: false,
  tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
});
client.on('error', (e) => console.error('redis error:', e.message));

const dec = (v) => {
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch (_) {
    return v;
  }
};

const STEPS = ['lyrics', 'song', 'thumbnail', 'video', 'upload'];

async function getJob(id) {
  return dec(await client.get(`job:${id}`));
}

async function setJob(id, job) {
  await client.set(`job:${id}`, JSON.stringify(job));
}

/** Merge a patch into a job (shallow-merging the per-step status map). */
async function updateJob(id, patch = {}) {
  const job = await getJob(id);
  if (!job) return null;
  const next = {
    ...job,
    ...patch,
    steps: { ...(job.steps || {}), ...(patch.steps || {}) },
    updatedAt: new Date().toISOString(),
  };
  await setJob(id, next);
  return next;
}

/** Blocking pop from the queue; returns a job id or null after `timeoutSec`. */
async function popQueue(timeoutSec = 5) {
  // brpop pairs with the web app's lpush -> FIFO order.
  const res = await client.brpop('jobs:queue', timeoutSec);
  if (!res) return null;
  return dec(res[1]);
}

/** Accept a raw playlist id or a full YouTube URL and return the id. */
function parsePlaylistId(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return m ? m[1] : s;
}

async function getConfig() {
  const stored = (await dec(await client.get('config'))) || {};
  // env vars act as a fallback, same precedence as the web app
  const pick = (kvKey, envKey, dflt = '') => {
    const v = stored[kvKey];
    if (v != null && String(v).trim() !== '') return String(v);
    const e = process.env[envKey];
    if (e != null && String(e).trim() !== '') return String(e);
    return dflt;
  };
  return {
    openaiApiKey: pick('openaiApiKey', 'OPENAI_API_KEY'),
    openaiModel: pick('openaiModel', 'OPENAI_MODEL', 'gpt-4o-mini'),
    openaiBaseUrl: pick('openaiBaseUrl', 'OPENAI_BASE_URL', 'https://api.openai.com/v1'),

    sunoBaseUrl: pick('sunoBaseUrl', 'SUNO_PROVIDER_BASE_URL'),
    sunoApiKey: pick('sunoApiKey', 'SUNO_PROVIDER_API_KEY'),
    sunoMode: pick('sunoMode', 'SUNO_MODE', 'suno-api'),
    sunoSubmitPath: pick('sunoSubmitPath', 'SUNO_SUBMIT_PATH', '/api/generate'),
    sunoStatusPath: pick('sunoStatusPath', 'SUNO_STATUS_PATH', '/api/status'),

    geminiApiKey: pick('geminiApiKey', 'GEMINI_API_KEY'),
    geminiImageModel: pick('geminiImageModel', 'GEMINI_IMAGE_MODEL', 'gemini-2.0-flash-preview-image-generation'),

    ytClientId: pick('ytClientId', 'YT_CLIENT_ID'),
    ytClientSecret: pick('ytClientSecret', 'YT_CLIENT_SECRET'),
    ytRefreshToken: pick('ytRefreshToken', 'YT_REFRESH_TOKEN'),
    ytPrivacyStatus: pick('ytPrivacyStatus', 'YT_PRIVACY_STATUS', 'public'),

    ytPlaylistId: parsePlaylistId(pick('ytPlaylistId', 'YT_PLAYLIST_ID')),
    playlistTopic: pick('playlistTopic', 'PLAYLIST_TOPIC'),
    songLanguage: pick('songLanguage', 'SONG_LANGUAGE', 'Gujarati'),

    videoMode: pick('videoMode', 'VIDEO_MODE', 'auto'),
    clipsPerSong: parseInt(pick('clipsPerSong', 'CLIPS_PER_SONG', '3'), 10) || 3,
    sceneCount: parseInt(pick('sceneCount', 'SCENE_COUNT', '4'), 10) || 4,
    sceneSeconds: parseInt(pick('sceneSeconds', 'SCENE_SECONDS', '8'), 10) || 8,

    // hands-free behaviour
    autoRetries: Math.max(0, parseInt(pick('autoRetries', 'AUTO_RETRIES', '2'), 10) || 0),
    songsPerDay: Math.max(1, parseInt(pick('songsPerDay', 'SONGS_PER_DAY', '1'), 10) || 1),
    timezone: pick('timezone', 'TIMEZONE', 'Asia/Kolkata'),

    driveRefreshToken: pick('driveRefreshToken', 'DRIVE_REFRESH_TOKEN'),
    driveFolderName: pick('driveFolderName', 'DRIVE_FOLDER_NAME', 'AI Song Engine'),
    driveKeepSongs: parseInt(pick('driveKeepSongs', 'DRIVE_KEEP_SONGS', '4'), 10) || 4,
    localSavePath: pick('localSavePath', 'LOCAL_SAVE_PATH'),
  };
}

/**
 * Write a heartbeat so the dashboard can show whether a worker is connected.
 * Important for home-PC workers, which have no public URL to probe.
 */
async function beat(extra = {}) {
  const payload = {
    ts: Date.now(),
    platform: process.platform,
    node: process.versions.node,
    ...extra,
  };
  // Expire after 90s so a stopped worker shows as offline on its own.
  await client.set('worker:heartbeat', JSON.stringify(payload), 'EX', 90);
}

// --------------------------------------------------------- autopilot ------
// The worker is the only always-on part of the system, so it also owns the
// daily schedule, crash recovery and automatic retries. Everything below keeps
// the exact key layout the web app uses (values are JSON-encoded).

const enc = (v) => JSON.stringify(v);

const DEFAULT_SCHEDULE = { enabled: false, hour: 14, minute: 0 };

async function getSchedule() {
  const s = dec(await client.get('schedule'));
  return s && typeof s === 'object' ? { ...DEFAULT_SCHEDULE, ...s } : { ...DEFAULT_SCHEDULE };
}

/** Push a job id onto the worker queue (same encoding as the web app). */
async function enqueueJob(id) {
  await client.lpush('jobs:queue', enc(id));
  return id;
}

/** Ids of the most recent jobs, newest first. */
async function listRecentJobIds(limit = 25) {
  const arr = await client.lrange('jobs:index', 0, limit - 1);
  return (arr || []).map(dec).filter(Boolean);
}

/**
 * Create a job record exactly like the web app does, so the dashboard renders
 * worker-created jobs (daily autopilot runs) identically.
 */
async function createJob(seed = {}) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const job = {
    id,
    status: 'queued',
    step: null,
    progress: 0,
    note: 'Waiting for the worker to pick this up…',
    trigger: seed.trigger || 'autopilot',
    createdAt: now,
    updatedAt: now,
    error: null,
    steps: STEPS.reduce((acc, s) => ({ ...acc, [s]: 'pending' }), {}),
    title: null,
    mood: null,
    styleTags: null,
    lyrics: null,
    audioUrl: null,
    videoUrl: null,
    youtubeId: null,
    youtubeUrl: null,
    ...seed,
  };
  await setJob(id, job);
  await client.lpush('jobs:index', enc(id));
  return job;
}

/**
 * Atomically claim a one-off action (e.g. "today's 14:00 run").
 * Returns true only for the first caller - this is what stops the Vercel cron
 * and the worker's own scheduler from both firing the same daily run.
 */
async function claim(key, ttlSec) {
  const res = await client.set(key, '1', 'EX', ttlSec, 'NX');
  return res === 'OK';
}

/** Re-run a job later (automatic retry after a transient failure). */
async function scheduleRetry(id, atMs) {
  await client.zadd('jobs:retry', String(atMs), id);
}

/** Pop every retry whose time has come. */
async function dueRetries(now = Date.now()) {
  const ids = await client.zrangebyscore('jobs:retry', '-inf', String(now));
  if (!ids || !ids.length) return [];
  await client.zrem('jobs:retry', ...ids);
  return ids;
}

async function cancelRetry(id) {
  await client.zrem('jobs:retry', id).catch(() => {});
}

/**
 * A single banner the dashboard shows when something needs a human (the only
 * case today: the Suno cookie has expired). Cleared on the next success.
 */
async function setAlert(text, kind = 'warn') {
  if (!text) return client.del('worker:alert');
  return client.set('worker:alert', enc({ text, kind, ts: Date.now() }), 'EX', 7 * 24 * 3600);
}

module.exports = {
  client,
  STEPS,
  getJob,
  setJob,
  updateJob,
  popQueue,
  getConfig,
  beat,
  getSchedule,
  enqueueJob,
  createJob,
  listRecentJobIds,
  claim,
  scheduleRetry,
  dueRetries,
  cancelRetry,
  setAlert,
};
