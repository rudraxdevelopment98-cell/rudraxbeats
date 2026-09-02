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
    songLanguage: pick('songLanguage', 'SONG_LANGUAGE', 'English'),

    driveFolderName: pick('driveFolderName', 'DRIVE_FOLDER_NAME', 'AI Song Engine'),
    driveKeepSongs: parseInt(pick('driveKeepSongs', 'DRIVE_KEEP_SONGS', '4'), 10) || 4,
  };
}

module.exports = { client, STEPS, getJob, setJob, updateJob, popQueue, getConfig };
