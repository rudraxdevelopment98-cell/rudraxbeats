// lib/oauthRedirect.js
// Compute the OAuth callback URI from the incoming request so it matches
// whatever domain the user is on. This exact URI must be registered in the
// Google Cloud OAuth client's "Authorized redirect URIs".

export function appOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

export function callbackUri(req) {
  return `${appOrigin(req)}/api/oauth/youtube/callback`;
}
