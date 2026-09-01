// pages/api/config.js
// GET  -> browser-safe config (secrets masked) + readiness checklist
// POST -> update config (secrets left unchanged when submitted blank)
// Both require an authenticated session.

import { getPublicConfig, setConfig, getReadiness } from '../../lib/config.js';
import { requireAuth } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      const [config, readiness] = await Promise.all([getPublicConfig(), getReadiness()]);
      return res.status(200).json({ ...config, readiness });
    }

    if (req.method === 'POST') {
      const patch = req.body || {};
      const config = await setConfig(patch);
      const readiness = await getReadiness();
      return res.status(200).json({ ...config, readiness });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
