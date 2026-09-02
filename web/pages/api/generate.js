// pages/api/generate.js
// POST - one-click manual trigger. Creates a job and pushes it onto the Redis
// queue; the always-on worker runs the full pipeline. This returns instantly,
// so Vercel's serverless time limit never applies to the actual work.

import { createJob, enqueueJob } from '../../lib/db.js';
import { requireAuth } from '../../lib/auth.js';
import { wakeWorker } from '../../lib/wakeWorker.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await requireAuth(req, res))) return;

  try {
    const job = await createJob({ trigger: 'manual' });
    await enqueueJob(job.id);
    // Free hosting tiers sleep when idle; a Redis write won't wake them.
    await wakeWorker();
    return res.status(202).json({ ok: true, jobId: job.id, job });
  } catch (err) {
    console.error('generate handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
