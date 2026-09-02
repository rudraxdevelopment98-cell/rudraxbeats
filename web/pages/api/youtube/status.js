// pages/api/youtube/status.js
// GET (auth-guarded) -> who is connected: { connected, channel, redirectUri }

import { getConnectedChannel } from '../../../lib/youtube.js';
import { requireAuth } from '../../../lib/auth.js';
import { callbackUri } from '../../../lib/oauthRedirect.js';
import { getConfig } from '../../../lib/config.js';

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  const redirectUri = callbackUri(req);
  // Drive is a SEPARATE consent (Google won't mix YouTube + Drive scopes),
  // so it has its own token and its own connected flag.
  const cfg = await getConfig();
  const driveConnected = Boolean(cfg.driveRefreshToken);
  try {
    const channel = await getConnectedChannel();
    return res
      .status(200)
      .json({ connected: Boolean(channel), channel, redirectUri, driveConnected });
  } catch (e) {
    // Token invalid/expired or scope missing - report as not connected + why.
    return res.status(200).json({
      connected: false,
      channel: null,
      redirectUri,
      driveConnected,
      error: String(e.message || e).slice(0, 160),
    });
  }
}
