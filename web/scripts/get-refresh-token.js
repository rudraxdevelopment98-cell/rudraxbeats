#!/usr/bin/env node
/**
 * One-time helper to obtain a YouTube refresh token.
 *
 * Prereqs:
 *   1. In Google Cloud Console, enable "YouTube Data API v3".
 *   2. Create an OAuth 2.0 Client ID of type "Desktop app".
 *   3. On the OAuth consent screen add the account that owns the target
 *      YouTube channel as a Test user (or publish the app).
 *
 * Usage:
 *   YT_CLIENT_ID=... YT_CLIENT_SECRET=... node scripts/get-refresh-token.js
 *
 * It prints a URL. Open it in a browser SIGNED IN AS THE CHANNEL OWNER,
 * approve, copy the code back into the terminal, and it prints the
 * refresh token to store as YT_REFRESH_TOKEN.
 *
 * (No dependency on next; only needs `googleapis`, installed in this package.)
 */

const readline = require('readline');
const { google } = require('googleapis');

const CLIENT_ID = process.env.YT_CLIENT_ID;
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET;
// The out-of-band redirect for Desktop-app clients:
const REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set YT_CLIENT_ID and YT_CLIENT_SECRET in the environment first.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline', // <- required to receive a refresh_token
  prompt: 'consent', // force refresh_token even on re-consent
  scope: SCOPES,
});

console.log('\n1) Open this URL in a browser signed in as the CHANNEL OWNER:\n');
console.log(authUrl);
console.log('\n2) Approve access, then paste the code Google gives you here.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste code: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2.getToken(code.trim());
    if (!tokens.refresh_token) {
      console.error(
        '\nNo refresh_token returned. Revoke prior access at ' +
          'https://myaccount.google.com/permissions and retry (the consent ' +
          'flow only returns a refresh_token on first grant / prompt=consent).'
      );
      process.exit(1);
    }
    console.log('\n=== SUCCESS ===');
    console.log('Set this in Vercel as YT_REFRESH_TOKEN:\n');
    console.log(tokens.refresh_token);
    console.log('');
  } catch (e) {
    console.error('\nToken exchange failed:', e.message);
    process.exit(1);
  }
});
