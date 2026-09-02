// pages/api/cron.js
// Called by Vercel Cron daily (see vercel.json). Enqueues a job for the
// always-on worker; the schedule stored in KV acts as an enable/disable gate.

import { getSchedule, createJob, enqueueJob, getWorkerHeartbeat, claimOnce } from '../../lib/db.js';
import { wakeWorker } from '../../lib/wakeWorker.js';
import { getConfig } from '../../lib/config.js';

/** Today's date in the user's timezone - the worker keys its claim the same way. */
function localDay(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

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

    // The worker owns the schedule now: it is always on and fires at the exact
    // local time chosen in Settings. This cron is only the backup for a worker
    // that is asleep - the job then waits in the queue until it wakes up.
    const hb = await getWorkerHeartbeat();
    if (hb.online) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'worker runs its own schedule' });
    }

    // Same claim key the worker uses, so a day can never fire twice.
    const cfg = await getConfig();
    const day = localDay(cfg.timezone);
    const claimed = await claimOnce(`autopilot:fired:${day}`, 22 * 3600);
    if (!claimed) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'already ran today' });
    }

    const job = await createJob({ trigger: 'cron' });
    await enqueueJob(job.id);
    // Free hosting tiers sleep when idle; a Redis write won't wake them.
    await wakeWorker();
    return res.status(202).json({ ok: true, jobId: job.id });
  } catch (err) {
    console.error('cron handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
