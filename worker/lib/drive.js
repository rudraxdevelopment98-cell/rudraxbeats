// worker/lib/drive.js
// Google Drive storage for generated songs + retention ("keep last N songs").
//
// Files are created with the drive.file scope, so this app can only see and
// delete the files it created itself - it never touches the rest of the Drive.
//
// Layout: one folder (default "AI Song Engine") containing per-song files
// named "<jobId>__<title>.mp4" / ".mp3" / ".png". Retention deletes the oldest
// songs' files once more than N songs are stored.

const fs = require('fs');
const { google } = require('googleapis');

function driveClient(cfg) {
  if (!cfg.ytClientId || !cfg.ytClientSecret || !cfg.ytRefreshToken) {
    throw new Error('Google account not connected (Settings → Connect YouTube)');
  }
  const oauth2 = new google.auth.OAuth2(cfg.ytClientId, cfg.ytClientSecret);
  oauth2.setCredentials({ refresh_token: cfg.ytRefreshToken });
  return google.drive({ version: 'v3', auth: oauth2 });
}

/** Find (or create) the app folder; returns its id. */
async function ensureFolder(drive, name) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
  const found = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 });
  if (found.data.files && found.data.files.length) return found.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return created.data.id;
}

/**
 * Upload one local file into the folder.
 * @returns {Promise<{id, name, webViewLink, webContentLink}>}
 */
async function uploadFile(drive, folderId, filePath, name, mimeType) {
  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id,name,webViewLink,webContentLink',
  });
  return res.data;
}

/**
 * Store a song's artifacts in Drive.
 * @returns {Promise<{folderId, files: object[], videoFileId: string}>}
 */
async function storeSong(cfg, { jobId, title, videoPath, audioPath, imagePath }) {
  const drive = driveClient(cfg);
  const folderId = await ensureFolder(drive, cfg.driveFolderName || 'AI Song Engine');
  const safe = String(title || 'song').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
  const stem = `${jobId}__${safe}`;

  const files = [];
  if (videoPath && fs.existsSync(videoPath)) {
    files.push(await uploadFile(drive, folderId, videoPath, `${stem}.mp4`, 'video/mp4'));
  }
  if (audioPath && fs.existsSync(audioPath)) {
    files.push(await uploadFile(drive, folderId, audioPath, `${stem}.mp3`, 'audio/mpeg'));
  }
  if (imagePath && fs.existsSync(imagePath)) {
    files.push(await uploadFile(drive, folderId, imagePath, `${stem}.png`, 'image/png'));
  }

  const video = files.find((f) => f.name.endsWith('.mp4'));
  return { folderId, files, videoFileId: video ? video.id : null };
}

/**
 * Keep only the newest `keep` songs in the folder; delete everything older.
 * Songs are grouped by the "<jobId>__" filename prefix.
 * @returns {Promise<{deletedSongs: number, deletedFiles: number}>}
 */
async function enforceRetention(cfg, keep) {
  const drive = driveClient(cfg);
  const folderId = await ensureFolder(drive, cfg.driveFolderName || 'AI Song Engine');

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id,name,createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 200,
  });
  const files = res.data.files || [];

  // Group by song prefix, preserving newest-first order.
  const order = [];
  const groups = new Map();
  for (const f of files) {
    const key = (f.name.split('__')[0] || f.name).trim();
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(f);
  }

  const doomed = order.slice(Math.max(0, keep));
  let deletedFiles = 0;
  for (const key of doomed) {
    for (const f of groups.get(key)) {
      try {
        await drive.files.delete({ fileId: f.id });
        deletedFiles++;
      } catch (e) {
        console.warn(`drive delete failed for ${f.name}: ${e.message}`);
      }
    }
  }
  return { deletedSongs: doomed.length, deletedFiles };
}

module.exports = { storeSong, enforceRetention, driveClient, ensureFolder };
