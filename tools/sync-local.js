#!/usr/bin/env node
/**
 * sync-local.js — download finished songs from Google Drive to THIS computer.
 *
 * Why this exists: a website (Vercel/Railway) can never write files onto your
 * PC — browsers forbid it. So the engine stores every finished song in Google
 * Drive, and this small script (run on your own machine) pulls new files down
 * into the folder you choose.
 *
 * TIP: If you install "Google Drive for Desktop", the Drive folder already
 * syncs to your PC automatically and you do NOT need this script at all.
 *
 * Setup (one time):
 *   1. npm install googleapis          (inside this tools/ folder)
 *   2. Set the four env vars below (same values the dashboard uses).
 *   3. node sync-local.js
 *
 * Env:
 *   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN   (from your Google OAuth)
 *   DRIVE_FOLDER_NAME   (default "AI Song Engine")
 *   LOCAL_SAVE_PATH     (where to save, e.g. D:\Songs  or /home/me/Songs)
 *   POLL_MINUTES        (default 10; how often to check for new files)
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CLIENT_ID = process.env.YT_CLIENT_ID;
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN;
const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME || 'AI Song Engine';
const SAVE_PATH = process.env.LOCAL_SAVE_PATH || path.join(process.cwd(), 'downloads');
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 10);

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('Set YT_CLIENT_ID, YT_CLIENT_SECRET and YT_REFRESH_TOKEN first.');
  process.exit(1);
}

function drive() {
  const o = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  o.setCredentials({ refresh_token: REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: o });
}

async function folderId(d) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME.replace(/'/g, "\\'")}' and trashed=false`;
  const r = await d.files.list({ q, fields: 'files(id)', pageSize: 1 });
  return r.data.files?.[0]?.id || null;
}

async function downloadOne(d, file, dest) {
  const res = await d.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.data.on('error', reject).pipe(out).on('finish', resolve).on('error', reject);
  });
}

async function syncOnce() {
  const d = drive();
  const fid = await folderId(d);
  if (!fid) {
    console.log(`Drive folder "${FOLDER_NAME}" not found yet — generate a song first.`);
    return;
  }
  fs.mkdirSync(SAVE_PATH, { recursive: true });

  const r = await d.files.list({
    q: `'${fid}' in parents and trashed=false`,
    fields: 'files(id,name,size,createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 200,
  });

  let got = 0;
  for (const f of r.data.files || []) {
    const dest = path.join(SAVE_PATH, f.name);
    if (fs.existsSync(dest) && String(fs.statSync(dest).size) === String(f.size || '')) continue;
    process.stdout.write(`↓ ${f.name} … `);
    try {
      await downloadOne(d, f, dest);
      console.log('done');
      got++;
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }
  console.log(got ? `Saved ${got} new file(s) to ${SAVE_PATH}` : `Up to date (${SAVE_PATH})`);
}

(async function main() {
  console.log(`Watching Drive folder "${FOLDER_NAME}" → ${SAVE_PATH} (every ${POLL_MINUTES} min)`);
  for (;;) {
    try {
      await syncOnce();
    } catch (e) {
      console.error('sync error:', e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MINUTES * 60 * 1000));
  }
})();
