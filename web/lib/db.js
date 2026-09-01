// lib/db.js
// Vercel KV (Upstash Redis) data layer for jobs + schedule.
//
// Data model:
//   job:<id>            -> hash-ish JSON blob for a single pipeline run
//   jobs:index          -> list (LPUSH) of job ids, newest first
//   schedule            -> JSON { enabled, hour, minute }
//
// If KV env vars are missing we fall back to a tiny in-memory store so the
// app still boots for local dev (state is NOT persisted across restarts).

import { kv as vercelKv } from '@vercel/kv';

const HAS_KV = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

// --- in-memory fallback (dev only) -----------------------------------------
const mem = {
  jobs: new Map(),
  index: [],
  schedule: null,
};

const memStore = {
  async set(key, val) {
    if (key === 'schedule') mem.schedule = val;
    else mem.jobs.set(key, val);
  },
  async get(key) {
    if (key === 'schedule') return mem.schedule;
    return mem.jobs.get(key) ?? null;
  },
  async lpush(_key, val) {
    mem.index.unshift(val);
  },
  async lrange(_key, start, stop) {
    const end = stop === -1 ? mem.index.length : stop + 1;
    return mem.index.slice(start, end);
  },
};

const store = HAS_KV ? vercelKv : memStore;

// Shared low-level store so lib/config.js and lib/auth.js persist to the same
// KV (or the same in-memory fallback for local dev).
export { store as kvStore };

export function kvConfigured() {
  return HAS_KV;
}

// --- ids -------------------------------------------------------------------
function newId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rnd}`;
}

// The steps every job walks through, in order.
export const STEPS = ['lyrics', 'song', 'thumbnail', 'video', 'upload'];

// --- jobs ------------------------------------------------------------------

/**
 * Create a new job record and push it onto the index.
 * @param {object} [seed] optional initial fields (e.g. { trigger: 'cron' })
 * @returns {Promise<object>} the created job
 */
export async function createJob(seed = {}) {
  const id = newId();
  const now = new Date().toISOString();
  const job = {
    id,
    status: 'pending', // pending | running | done | error
    step: null, // current/last step
    trigger: seed.trigger || 'manual',
    createdAt: now,
    updatedAt: now,
    error: null,
    // per-step status map: 'pending' | 'running' | 'done' | 'error'
    steps: STEPS.reduce((acc, s) => ({ ...acc, [s]: 'pending' }), {}),
    // artifacts filled in as the pipeline runs
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
  await store.set(`job:${id}`, job);
  await store.lpush('jobs:index', id);
  return job;
}

/**
 * Merge patch into an existing job and persist it.
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object|null>} updated job (or null if not found)
 */
export async function updateJob(id, patch = {}) {
  const job = await getJob(id);
  if (!job) return null;
  const next = {
    ...job,
    ...patch,
    // shallow-merge the steps map so callers can patch a single step
    steps: { ...job.steps, ...(patch.steps || {}) },
    updatedAt: new Date().toISOString(),
  };
  await store.set(`job:${id}`, next);
  return next;
}

/** Convenience helper: mark a single step's status (and set job.step). */
export async function setStep(id, step, status, extra = {}) {
  return updateJob(id, {
    step,
    status: status === 'error' ? 'error' : 'running',
    steps: { [step]: status },
    ...extra,
  });
}

export async function getJob(id) {
  if (!id) return null;
  return (await store.get(`job:${id}`)) ?? null;
}

/**
 * Return the most recent jobs, newest first.
 * @param {number} [limit=25]
 */
export async function listJobs(limit = 25) {
  const ids = await store.lrange('jobs:index', 0, limit - 1);
  if (!ids || ids.length === 0) return [];
  const jobs = await Promise.all(ids.map((id) => getJob(id)));
  return jobs.filter(Boolean);
}

// --- schedule --------------------------------------------------------------

const DEFAULT_SCHEDULE = { enabled: false, hour: 14, minute: 0 };

export async function getSchedule() {
  const s = await store.get('schedule');
  return s ? { ...DEFAULT_SCHEDULE, ...s } : { ...DEFAULT_SCHEDULE };
}

/**
 * @param {{enabled?: boolean, hour?: number, minute?: number}} patch
 */
export async function setSchedule(patch = {}) {
  const current = await getSchedule();
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    hour: clampInt(patch.hour, 0, 23, current.hour),
    minute: clampInt(patch.minute, 0, 59, current.minute),
  };
  await store.set('schedule', next);
  return next;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
