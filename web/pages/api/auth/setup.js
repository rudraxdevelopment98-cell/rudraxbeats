// pages/api/auth/setup.js
// POST { password } -> creates the initial admin password (first-run only)
// and immediately logs the user in.

import { setupPassword, issueSession } from '../../../lib/auth.js';
import { kvConfigured } from '../../../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!kvConfigured()) {
    return res.status(400).json({
      error:
        'No KV store attached. Attach a Vercel KV store to the project first ' +
        '(Vercel > project > Storage > Create > KV), then reload.',
    });
  }
  try {
    const { password } = req.body || {};
    await setupPassword(password);
    await issueSession(res);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
