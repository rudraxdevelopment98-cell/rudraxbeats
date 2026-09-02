// pages/api/job-action.js
// POST { id, action: 'delete' | 'cancel' | 'retry' }  (auth-guarded)
//  - delete: remove the job
//  - cancel: mark a running job as errored/cancelled
//  - retry:  start a fresh pipeline run and return the new jobId

import { requireAuth } from '../../lib/auth.js';
import { deleteJob, cancelJob, createJob, enqueueJob } from '../../lib/db.js';

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { id, action } = req.body || {};
    if (action === 'delete') {
      await deleteJob(id);
      return res.status(200).json({ ok: true });
    }
    if (action === 'cancel') {
      const job = await cancelJob(id);
      return res.status(200).json({ ok: true, job });
    }
    if (action === 'retry') {
      const job = await createJob({ trigger: 'manual' });
      await enqueueJob(job.id);
      return res.status(202).json({ ok: true, jobId: job.id });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
