// pages/api/oauth/youtube/start.js
// GET (auth-guarded) -> redirects the browser to Google's consent screen.
// Google shows an account chooser so the user picks WHICH channel to connect.

import { getConfig } from '../../../../lib/config.js';
import { buildConsentUrl } from '../../../../lib/youtube.js';
import { requireAuth } from '../../../../lib/auth.js';
import { callbackUri } from '../../../../lib/oauthRedirect.js';

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  const cfg = await getConfig();
  if (!cfg.ytClientId || !cfg.ytClientSecret) {
    return res
      .status(400)
      .send('Enter the YouTube Client ID and Client Secret in Settings and Save first, then click Connect.');
  }
  const url = buildConsentUrl(cfg, callbackUri(req));
  res.redirect(url);
}
