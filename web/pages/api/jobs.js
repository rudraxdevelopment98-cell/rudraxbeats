// pages/api/jobs.js
// GET -> recent jobs (newest first) for the dashboard history view.
// Optional query: ?limit=25

import { listJobs } from '../../lib/db.js';
import { requireAuth } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await requireAuth(req, res))) return;

  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const jobs = await listJobs(limit);
    return res.status(200).json({ jobs });
  } catch (err) {
    console.error('jobs handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
