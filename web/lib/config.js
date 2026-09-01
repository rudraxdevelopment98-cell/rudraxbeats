// lib/config.js
// Central runtime configuration. Values are read from the KV "config" object
// (set via the dashboard Settings page) and fall back to environment
// variables, then to sane defaults. This lets the user manage every API key
// from the web UI instead of Vercel env vars.
//
// Precedence for each field:   KV value (if non-empty)  >  env var  >  default
//
// Secret fields are never returned in full to the browser - getPublicConfig()
// returns only { set, hint } for them.

import { kvConfigured, kvStore } from './db.js';

const CONFIG_KEY = 'config';

// Canonical field schema. `env` is the fallback environment variable name.
export const FIELDS = {
  // Lyrics (OpenAI)
  openaiApiKey: { env: 'OPENAI_API_KEY', secret: true, label: 'OpenAI API Key', group: 'Lyrics (OpenAI)' },
  openaiModel: { env: 'OPENAI_MODEL', default: 'gpt-4o-mini', label: 'OpenAI Model', group: 'Lyrics (OpenAI)' },
  openaiBaseUrl: { env: 'OPENAI_BASE_URL', default: 'https://api.openai.com/v1', label: 'OpenAI Base URL', group: 'Lyrics (OpenAI)' },

  // Song (third-party Suno wrapper)
  sunoBaseUrl: { env: 'SUNO_PROVIDER_BASE_URL', label: 'Suno Provider Base URL', group: 'Song (Suno wrapper)' },
  sunoApiKey: { env: 'SUNO_PROVIDER_API_KEY', secret: true, label: 'Suno Provider API Key', group: 'Song (Suno wrapper)' },
  sunoSubmitPath: { env: 'SUNO_SUBMIT_PATH', default: '/api/generate', label: 'Suno Submit Path', group: 'Song (Suno wrapper)' },
  sunoStatusPath: { env: 'SUNO_STATUS_PATH', default: '/api/status', label: 'Suno Status Path', group: 'Song (Suno wrapper)' },
  sunoModel: { env: 'SUNO_MODEL', default: 'chirp-v3-5', label: 'Suno Model', group: 'Song (Suno wrapper)' },

  // Thumbnail (Gemini)
  geminiApiKey: { env: 'GEMINI_API_KEY', secret: true, label: 'Gemini API Key', group: 'Thumbnail (Gemini)' },
  geminiImageModel: { env: 'GEMINI_IMAGE_MODEL', default: 'gemini-2.0-flash-preview-image-generation', label: 'Gemini Image Model', group: 'Thumbnail (Gemini)' },

  // Video worker
  workerUrl: { env: 'WORKER_URL', label: 'Worker URL', group: 'Video worker' },
  workerSecret: { env: 'WORKER_SECRET', secret: true, label: 'Worker Secret', group: 'Video worker' },

  // YouTube
  ytClientId: { env: 'YT_CLIENT_ID', label: 'YouTube OAuth Client ID', group: 'YouTube upload' },
  ytClientSecret: { env: 'YT_CLIENT_SECRET', secret: true, label: 'YouTube OAuth Client Secret', group: 'YouTube upload' },
  ytRefreshToken: { env: 'YT_REFRESH_TOKEN', secret: true, label: 'YouTube Refresh Token', group: 'YouTube upload' },
  ytPrivacyStatus: { env: 'YT_PRIVACY_STATUS', default: 'public', label: 'Upload Privacy (public/unlisted/private)', group: 'YouTube upload' },
};

async function readStored() {
  try {
    const raw = await kvStore.get(CONFIG_KEY);
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

/**
 * Fully-resolved config used by the pipeline (secrets included).
 * @returns {Promise<Record<string,string>>}
 */
export async function getConfig() {
  const stored = await readStored();
  const out = {};
  for (const [key, def] of Object.entries(FIELDS)) {
    const fromKv = stored[key];
    const fromEnv = def.env ? process.env[def.env] : undefined;
    const val =
      fromKv != null && String(fromKv).trim() !== ''
        ? fromKv
        : fromEnv != null && String(fromEnv).trim() !== ''
          ? fromEnv
          : def.default ?? '';
    out[key] = val;
  }
  return out;
}

/**
 * Update stored config. Only keys present in `patch` are touched. For secret
 * fields an empty string means "leave unchanged" (so the masked UI can submit
 * blanks safely). Non-secret fields can be set to empty to clear them.
 * @param {Record<string,string>} patch
 */
export async function setConfig(patch = {}) {
  if (!kvConfigured()) {
    throw new Error(
      'No KV store attached. Attach a Vercel KV store to the project first so ' +
        'settings can be saved (Vercel > project > Storage > Create > KV).'
    );
  }
  const stored = await readStored();
  const next = { ...stored };
  for (const [key, def] of Object.entries(FIELDS)) {
    if (!(key in patch)) continue;
    const val = patch[key];
    if (val === undefined) continue;
    const str = val == null ? '' : String(val);
    if (def.secret && str.trim() === '') continue; // don't wipe secrets on blank
    next[key] = str;
  }
  await kvStore.set(CONFIG_KEY, next);
  return getPublicConfig();
}

/**
 * Browser-safe view: real values for non-secrets, only { set, hint } for
 * secrets. Also reports whether each value currently comes from KV or env.
 */
export async function getPublicConfig() {
  const stored = await readStored();
  const resolved = await getConfig();
  const fields = {};
  for (const [key, def] of Object.entries(FIELDS)) {
    const value = resolved[key];
    const set = String(value || '').trim() !== '';
    const fromEnvOnly = (stored[key] == null || String(stored[key]).trim() === '') && set;
    if (def.secret) {
      const s = String(value || '');
      fields[key] = {
        secret: true,
        set,
        hint: set ? `••••${s.slice(-4)}` : '',
        source: fromEnvOnly ? 'env' : set ? 'saved' : 'none',
        label: def.label,
        group: def.group,
      };
    } else {
      fields[key] = {
        secret: false,
        set,
        value,
        source: fromEnvOnly ? 'env' : stored[key] != null ? 'saved' : 'default',
        label: def.label,
        group: def.group,
      };
    }
  }
  return { fields, kvConfigured: kvConfigured() };
}

/**
 * Which pipeline steps are ready to run given the current config?
 * Used by the dashboard to show a readiness checklist.
 */
export async function getReadiness() {
  const c = await getConfig();
  return {
    lyrics: Boolean(c.openaiApiKey),
    song: Boolean(c.sunoBaseUrl && c.sunoApiKey),
    thumbnail: Boolean(c.geminiApiKey),
    video: Boolean(c.workerUrl && c.workerSecret),
    upload: Boolean(c.ytClientId && c.ytClientSecret && c.ytRefreshToken),
  };
}
