// lib/googleClient.js
// The Google OAuth *Client ID* is public (it is sent to every browser to
// render the sign-in button), so it is safe to ship as a built-in default.
// The GOOGLE_CLIENT_ID env var overrides it if you ever change projects.
//
// NOTE: never put the Client SECRET here - that stays only in the Settings
// page (KV), never in code.
export const DEFAULT_GOOGLE_CLIENT_ID =
  '814368754759-j67l9sl8ohrai7dbs9d7h9m6v27i65eb.apps.googleusercontent.com';
