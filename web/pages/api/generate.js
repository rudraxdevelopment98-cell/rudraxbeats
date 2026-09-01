// pages/api/generate.js
// POST - one-click manual trigger. Creates a job, kicks off the pipeline in
// the background, and returns the jobId immediately so the dashboard can poll
// /api/jobs for progress instead of blocking on the multi-minute pipeline.
//
// NOTE (serverless caveat): on Vercel, work after the response is not
// guaranteed to finish before the function is frozen. For an MVP with
// maxDuration=60 (see vercel.json) short pipelines complete; for production
// move runPipeline() onto a durable queue/worker (see README "Scaling").

import { createJob } from '../../lib/db.js';
import { runPipeline } from '../../lib/pipeline.js';
import { requireAuth } from '../../lib/auth.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await requireAuth(req, res))) return;

  try {
    const job = await createJob({ trigger: 'manual' });

    // Fire-and-forget: start the pipeline but respond right away.
    runPipeline({ jobId: job.id, trigger: 'manual' }).catch((err) => {
      console.error('runPipeline (manual) crashed:', err);
    });

    return res.status(202).json({ ok: true, jobId: job.id, job });
  } catch (err) {
    console.error('generate handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
