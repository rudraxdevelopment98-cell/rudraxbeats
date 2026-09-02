// pages/api/oauth/youtube/start.js
// GET ?service=youtube|drive  (auth-guarded) -> Google consent screen.
//
// Google refuses a consent request that mixes YouTube scopes with other Google
// APIs, so YouTube and Drive are connected in two separate flows. Both reuse
// this single registered redirect URI; the chosen service travels in `state`.

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
      .send('Enter the Google OAuth Client ID and Client Secret in Settings and Save first.');
  }
  const service = req.query.service === 'drive' ? 'drive' : 'youtube';
  res.redirect(buildConsentUrl(cfg, callbackUri(req), service));
}
