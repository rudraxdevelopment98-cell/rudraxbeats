// worker/lib/health.js
// Proactive checks for the two credentials that expire on their own, so the
// dashboard can warn BEFORE a night's run fails instead of after.
//
//   • the Suno cookie inside your self-hosted suno-api deployment
//   • the Google refresh token (which Google expires every 7 days while the
//     OAuth consent screen is still in "Testing")

const { google } = require('googleapis');

/** Is the Suno wrapper answering with a usable session? */
async function checkSuno(cfg) {
  const base = String(cfg.sunoBaseUrl || '').replace(/\/$/, '');
  if (!base) return { ok: true, skipped: 'no Suno wrapper configured yet' };
  const headers = cfg.sunoApiKey ? { Authorization: `Bearer ${cfg.sunoApiKey}` } : {};

  try {
    const res = await fetch(`${base}/api/get_limit`, { headers });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Suno rejected the session (HTTP ' + res.status + ')' };
    }
    if (!res.ok) return { ok: true, skipped: `wrapper answered ${res.status}` }; // wrapper quirk, not a cookie problem
    const data = await res.json().catch(() => null);
    // gcui-art/suno-api returns { credits_left, monthly_limit, ... } when the
    // cookie is good, and an error object when it is not.
    if (data && typeof data === 'object' && 'credits_left' in data) {
      const left = Number(data.credits_left);
      if (Number.isFinite(left) && left < 20) {
        return { ok: false, message: `Suno has only ${left} credits left — songs will start failing.` };
      }
      return { ok: true, credits: left };
    }
    if (data && (data.error || data.detail)) {
      return { ok: false, message: String(data.error || data.detail).slice(0, 160) };
    }
    return { ok: true };
  } catch (e) {
    // The wrapper being briefly unreachable is not a credential problem.
    return { ok: true, skipped: e.message };
  }
}

/** Can the stored Google refresh token still mint an access token? */
async function checkGoogleToken(cfg, refreshToken, label) {
  if (!cfg.ytClientId || !cfg.ytClientSecret || !refreshToken) {
    return { ok: true, skipped: `${label} not connected` };
  }
  const oauth2 = new google.auth.OAuth2(cfg.ytClientId, cfg.ytClientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  try {
    await oauth2.getAccessToken();
    return { ok: true };
  } catch (e) {
    const msg = String(e && (e.response?.data?.error || e.message) || e);
    if (/invalid_grant|unauthorized_client|invalid_client/i.test(msg)) {
      return {
        ok: false,
        message:
          `${label} login has expired — reconnect it in Settings. ` +
          'If this keeps happening weekly, publish your Google Cloud OAuth app ' +
          '(APIs & Services → OAuth consent screen → Publish) — while it is in ' +
          '"Testing", Google expires the token every 7 days.',
      };
    }
    return { ok: true, skipped: msg.slice(0, 120) }; // network blip, not a credential problem
  }
}

/**
 * Run every check and return one banner line (or null when all is well).
 * @returns {Promise<{text:string}|null>}
 */
async function runChecks(cfg) {
  const results = await Promise.all([
    checkSuno(cfg),
    checkGoogleToken(cfg, cfg.ytRefreshToken, 'YouTube'),
    checkGoogleToken(cfg, cfg.driveRefreshToken, 'Google Drive'),
  ]);
  const problems = results.filter((r) => !r.ok).map((r) => r.message);
  if (!problems.length) return null;
  return { text: problems.join('  ·  ') };
}

module.exports = { runChecks, checkSuno, checkGoogleToken };
