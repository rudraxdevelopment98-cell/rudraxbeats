// pages/api/youtube/disconnect.js
// POST (auth-guarded) -> forget the stored refresh token.

import { clearConfig } from '../../../lib/config.js';
import { requireAuth } from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await clearConfig(['ytRefreshToken']);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}
