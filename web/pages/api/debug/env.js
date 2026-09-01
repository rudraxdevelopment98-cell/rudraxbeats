// pages/api/debug/env.js
// TEMPORARY diagnostic. Lists NAMES (never values) of storage-related env vars
// and does a live read/write round-trip against the configured store to prove
// connectivity. Remove after debugging.

import { kvConfigured, kvStore } from '../../../lib/db.js';

export default async function handler(req, res) {
  const storageEnvKeys = Object.keys(process.env)
    .filter((k) => /KV|UPSTASH|REDIS|STORAGE|POSTGRES|BLOB/i.test(k))
    .sort();

  let ping = 'skipped';
  let error = null;
  if (kvConfigured()) {
    try {
      const stamp = Date.now();
      await kvStore.set('debug:ping', { stamp });
      const back = await kvStore.get('debug:ping');
      ping = back && back.stamp === stamp ? 'ok' : 'mismatch';
    } catch (e) {
      ping = 'failed';
      error = String(e.message || e).slice(0, 200);
    }
  }

  res.status(200).json({ storageEnvKeys, kvConfigured: kvConfigured(), ping, error });
}
