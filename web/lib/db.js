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

import { createClient } from '@vercel/kv';
import Redis from 'ioredis';

// We support three storage backends, picked automatically by which env vars
// Vercel injected when a store was attached:
//
//  1. Upstash REST  -> KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN
//                      (used by @vercel/kv over HTTP)
//  2. Redis TCP     -> REDIS_URL / KV_URL (a redis:// or rediss:// string;
//                      this is what a plain "Redis" Marketplace store gives)
//  3. in-memory     -> nothing set (local dev only; not persisted)
//
// For (2) we wrap ioredis in a tiny adapter that JSON-serializes values so it
// exposes the same get/set/lpush/lrange interface as @vercel/kv.
const KV_REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || process.env.REDIS_TCP_URL;

const HAS_REST = Boolean(KV_REST_URL && KV_REST_TOKEN);
const HAS_TCP = !HAS_REST && Boolean(REDIS_URL);
const HAS_KV = HAS_REST || HAS_TCP;

function makeTcpStore(url) {
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    // rediss:// implies TLS; ioredis enables it from the scheme, but be explicit.
    tls: url.startsWith('rediss://') ? {} : undefined,
    lazyConnect: false,
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
  return {
    async get(key) {
      return dec(await client.get(key));
    },
    async set(key, val) {
      await client.set(key, JSON.stringify(val));
    },
    async lpush(key, val) {
      await client.lpush(key, JSON.stringify(val));
    },
    async lrange(key, start, stop) {
      const arr = await client.lrange(key, start, stop);
      return (arr || []).map(dec);
    },
    async del(key) {
      await client.del(key);
    },
    async lrem(key, count, val) {
      // lpush stored JSON-encoded values, so match that encoding here.
      await client.lrem(key, count, JSON.stringify(val));
    },
  };
}

const vercelKv = HAS_REST
  ? createClient({ url: KV_REST_URL, token: KV_REST_TOKEN })
  : HAS_TCP
    ? makeTcpStore(REDIS_URL)
    : null;

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
  async del(key) {
    if (key === 'schedule') mem.schedule = null;
    else mem.jobs.delete(key);
  },
  async lrem(_key, _count, val) {
    mem.index = mem.index.filter((x) => x !== val);
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
    status: 'queued', // queued | running | done | error
    step: null, // current/last step
    progress: 0, // 0-100 overall
    note: 'Waiting for the worker to pick this up…', // human-readable progress
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

/**
 * Read the worker's heartbeat. A home-PC worker has no public URL, so this is
 * how the dashboard knows whether a worker is actually connected.
 * @returns {Promise<{online:boolean, ageSec:number|null, info:object|null}>}
 */
export async function getWorkerHeartbeat() {
  try {
    const raw = await store.get('worker:heartbeat');
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!info || !info.ts) return { online: false, ageSec: null, info: null };
    const ageSec = Math.round((Date.now() - Number(info.ts)) / 1000);
    return { online: ageSec < 90, ageSec, info };
  } catch (_) {
    return { online: false, ageSec: null, info: null };
  }
}

/**
 * Push a job id onto the worker queue. The always-on worker (Railway/Render)
 * pops from this list and runs the full pipeline, so Vercel never has to hold
 * a multi-minute request open.
 */
export async function enqueueJob(id) {
  await store.lpush('jobs:queue', id);
  return id;
}

/** Permanently remove a job and drop it from the index. */
export async function deleteJob(id) {
  if (!id) return false;
  await store.lrem('jobs:index', 0, id);
  await store.del(`job:${id}`);
  return true;
}

/** Mark a job cancelled (best-effort; a serverless run may still be mid-flight). */
export async function cancelJob(id) {
  const job = await getJob(id);
  if (!job) return null;
  const steps = { ...job.steps };
  for (const s of STEPS) if (steps[s] === 'running') steps[s] = 'error';
  return updateJob(id, { status: 'error', steps, error: 'Cancelled by user' });
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
