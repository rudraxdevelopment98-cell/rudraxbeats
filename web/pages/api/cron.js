// pages/api/cron.js
// Called by Vercel Cron daily (see vercel.json). Vercel Cron sends a GET with
// an "Authorization: Bearer <CRON_SECRET>" header when CRON_SECRET is set in
// the project, which we verify to prevent public triggering.
//
// The cron time in vercel.json is static at deploy time. The schedule stored
// in KV acts as an enable/disable GATE (option (a) from the spec): if the
// schedule is disabled we skip. The stored hour/minute is informational for
// the dashboard; to actually change WHEN cron fires you edit vercel.json and
// redeploy (documented in the README).

import { getSchedule, createJob } from '../../lib/db.js';
import { runPipeline } from '../../lib/pipeline.js';

export const config = { maxDuration: 60 };

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured -> allow (dev)
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const schedule = await getSchedule();
    if (!schedule.enabled) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'schedule disabled' });
    }

    const job = await createJob({ trigger: 'cron' });
    runPipeline({ jobId: job.id, trigger: 'cron' }).catch((err) => {
      console.error('runPipeline (cron) crashed:', err);
    });

    return res.status(202).json({ ok: true, jobId: job.id });
  } catch (err) {
    console.error('cron handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
