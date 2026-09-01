// pages/api/debug/env.js
// TEMPORARY diagnostic: lists the NAMES (never values) of storage-related
// environment variables so we can see what Vercel injected when a KV/Redis
// store is attached. Safe to expose (names only). Remove after debugging.

export default function handler(req, res) {
  const keys = Object.keys(process.env)
    .filter((k) => /KV|UPSTASH|REDIS|STORAGE|POSTGRES|BLOB/i.test(k))
    .sort();
  res.status(200).json({
    storageEnvKeys: keys,
    kvConfigured: Boolean(
      (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
        (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
    ),
  });
}
