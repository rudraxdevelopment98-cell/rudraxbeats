// pages/api/auth/me.js
// GET -> { setup, authed, kvConfigured }
// Tells the client whether a password exists, whether this session is logged
// in, and whether KV is attached (required for setup to work at all).

import { getAuthState, isAuthed } from '../../../lib/auth.js';
import { kvConfigured } from '../../../lib/db.js';

export default async function handler(req, res) {
  try {
    const kv = kvConfigured();
    // Without KV, auth state can't persist; report not-set-up so the UI can
    // show the "attach KV" message instead of a broken login.
    const { setup } = kv ? await getAuthState() : { setup: false };
    const authed = kv ? await isAuthed(req) : false;
    return res.status(200).json({ setup, authed, kvConfigured: kv });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
