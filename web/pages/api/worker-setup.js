// pages/api/worker-setup.js
// GET (OWNER only) -> everything needed to set up the desktop worker app:
// the download link, the REDIS_URL to paste into its first-run wizard, and
// whether a worker is currently connected.
//
// REDIS_URL is shown only to the owner, who can already read it in Vercel —
// surfacing it here just saves a trip, and the app needs it verbatim.

import { requireOwner } from '../../lib/auth.js';
import { getWorkerHeartbeat } from '../../lib/db.js';

const DOWNLOAD_PAGE =
  process.env.WORKER_APP_DOWNLOAD_URL ||
  'https://github.com/rudraxdevelopment98-cell/rudraxbeats/releases';

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  try {
    const hb = await getWorkerHeartbeat();
    const redisUrl =
      process.env.REDIS_URL ||
      process.env.KV_URL ||
      process.env.REDIS_TCP_URL ||
      '';
    return res.status(200).json({
      downloadPage: DOWNLOAD_PAGE,
      redisUrl,
      hasRedisUrl: Boolean(redisUrl),
      worker: { online: hb.online, ageSec: hb.ageSec, info: hb.info },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
