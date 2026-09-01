// pages/api/auth/google.js
// POST { credential } -> verify the Google ID token, enforce the allowlist,
// and issue a session. The first successful login becomes the owner.

import { verifyGoogleIdToken, isAllowed, ensureOwner, issueSession } from '../../../lib/auth.js';
import { kvConfigured } from '../../../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!kvConfigured()) {
    return res.status(400).json({
      error:
        'No KV store attached. Attach a Vercel KV store to the project first, then reload.',
    });
  }
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

    const user = await verifyGoogleIdToken(credential);

    if (!(await isAllowed(user.email))) {
      return res.status(403).json({
        error: `${user.email} is not allowed. Ask the owner to add your email in Settings → Access.`,
      });
    }

    await ensureOwner(user.email); // first login claims ownership
    await issueSession(res, user);
    return res.status(200).json({ ok: true, user });
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
}
