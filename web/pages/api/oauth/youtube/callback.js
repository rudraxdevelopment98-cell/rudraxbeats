// pages/api/oauth/youtube/callback.js
// Google redirects here after either consent flow. `state` tells us which one
// (youtube | drive) so the refresh token lands in the right config field.

import { getConfig, setConfig } from '../../../../lib/config.js';
import { exchangeCodeForTokens } from '../../../../lib/youtube.js';
import { isAuthed } from '../../../../lib/auth.js';
import { callbackUri } from '../../../../lib/oauthRedirect.js';

function back(res, params) {
  res.redirect(`/settings?${new URLSearchParams(params).toString()}`);
}

export default async function handler(req, res) {
  // The redirect carries the session cookie (same domain), so require auth.
  if (!(await isAuthed(req))) return res.redirect('/login');

  const { code, error, state } = req.query;
  const service = state === 'drive' ? 'drive' : 'youtube';

  if (error) return back(res, { [service]: 'error', reason: String(error) });
  if (!code) return back(res, { [service]: 'error', reason: 'no_code' });

  try {
    const cfg = await getConfig();
    const tokens = await exchangeCodeForTokens(cfg, callbackUri(req), String(code));
    if (!tokens.refresh_token) {
      // Happens when the account already granted access without revoking.
      return back(res, { [service]: 'norefresh' });
    }
    await setConfig(
      service === 'drive'
        ? { driveRefreshToken: tokens.refresh_token }
        : { ytRefreshToken: tokens.refresh_token }
    );
    return back(res, { [service]: 'connected' });
  } catch (e) {
    return back(res, { [service]: 'error', reason: String(e.message || e).slice(0, 140) });
  }
}
