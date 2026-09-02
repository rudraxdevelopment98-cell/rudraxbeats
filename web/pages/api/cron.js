// pages/api/cron.js
// Called by Vercel Cron daily (see vercel.json). Enqueues a job for the
// always-on worker; the schedule stored in KV acts as an enable/disable gate.

import { getSchedule, createJob, enqueueJob } from '../../lib/db.js';

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured -> allow (dev)
  return (req.headers.authorization || '') === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const schedule = await getSchedule();
    if (!schedule.enabled) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'schedule disabled' });
    }
    const job = await createJob({ trigger: 'cron' });
    await enqueueJob(job.id);
    return res.status(202).json({ ok: true, jobId: job.id });
  } catch (err) {
    console.error('cron handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
