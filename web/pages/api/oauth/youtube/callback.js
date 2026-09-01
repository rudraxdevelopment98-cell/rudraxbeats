// pages/api/oauth/youtube/callback.js
// Google redirects here after consent. We exchange the code for tokens and
// store the refresh_token in KV config, then bounce back to /settings.

import { getConfig, setConfig } from '../../../../lib/config.js';
import { exchangeCodeForTokens } from '../../../../lib/youtube.js';
import { isAuthed } from '../../../../lib/auth.js';
import { callbackUri } from '../../../../lib/oauthRedirect.js';

function back(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.redirect(`/settings?${qs}`);
}

export default async function handler(req, res) {
  // The redirect carries the session cookie (same domain), so require auth.
  if (!(await isAuthed(req))) return res.redirect('/login');

  const { code, error } = req.query;
  if (error) return back(res, { youtube: 'error', reason: String(error) });
  if (!code) return back(res, { youtube: 'error', reason: 'no_code' });

  try {
    const cfg = await getConfig();
    const tokens = await exchangeCodeForTokens(cfg, callbackUri(req), String(code));
    if (!tokens.refresh_token) {
      // Happens if the account previously granted access without revoking.
      return back(res, { youtube: 'norefresh' });
    }
    await setConfig({ ytRefreshToken: tokens.refresh_token });
    return back(res, { youtube: 'connected' });
  } catch (e) {
    return back(res, { youtube: 'error', reason: String(e.message || e).slice(0, 140) });
  }
}
