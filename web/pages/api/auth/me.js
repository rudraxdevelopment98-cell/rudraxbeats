// pages/api/auth/me.js
// GET -> { authed, user, isOwner, kvConfigured, loginConfigured, googleClientId }
// googleClientId is public (safe for the browser) and used to render the
// "Sign in with Google" button.

import { getSession, isOwner, getGoogleClientId, loginConfigured } from '../../../lib/auth.js';
import { kvConfigured } from '../../../lib/db.js';

export default async function handler(req, res) {
  try {
    const kv = kvConfigured();
    const session = kv ? await getSession(req) : null;
    let user = null;
    let owner = false;
    if (session) {
      user = { email: session.email, name: session.name, picture: session.picture };
      owner = await isOwner(session.email);
    }
    return res.status(200).json({
      authed: Boolean(session),
      user,
      isOwner: owner,
      kvConfigured: kv,
      loginConfigured: loginConfigured(),
      googleClientId: getGoogleClientId(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
