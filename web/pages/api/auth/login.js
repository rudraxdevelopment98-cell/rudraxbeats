// pages/api/auth/login.js
// POST { password } -> verifies and issues a session cookie.

import { verifyPassword, issueSession } from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { password } = req.body || {};
    const ok = await verifyPassword(password);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });
    await issueSession(res);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
