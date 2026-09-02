// worker/lib/localsave.js
// Copies each finished song straight into the folder chosen in Settings
// ("Local folder path"). The worker already runs on that PC, so this replaces
// the old manual step of running tools/sync-local.js by hand.
//
// Layout:  <local folder>/<YYYY-MM-DD> <title>/{video.mp4, song.mp3, cover.png, lyrics.txt}

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** Where finished songs go when Settings has no folder yet: next to the app. */
function defaultRoot() {
  const dirs = [];
  try {
    if (require.main && require.main.filename) dirs.push(path.dirname(require.main.filename));
  } catch (_) {}
  dirs.push(path.join(__dirname, '..'));
  return path.join(dirs[0], 'Songs');
}

const safe = (s) => String(s || 'song').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * @returns {Promise<{saved:boolean, dir:string|null, files:string[], reason?:string}>}
 */
async function saveLocally(cfg, { title, videoPath, audioPath, imagePath, lyrics, youtubeUrl }) {
  // Always save something to the PC: the configured folder when there is one,
  // otherwise a "Songs" folder next to the app. Nothing to set up by hand.
  const root = String(cfg.localSavePath || '').trim() || defaultRoot();

  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(root, `${day} ${safe(title)}`);
  await fsp.mkdir(dir, { recursive: true });

  const files = [];
  const copy = async (src, name) => {
    if (!src || !fs.existsSync(src)) return;
    const dest = path.join(dir, name);
    await fsp.copyFile(src, dest);
    files.push(dest);
  };

  await copy(videoPath, 'video.mp4');
  await copy(audioPath, 'song.mp3');
  await copy(imagePath, 'cover.png');

  if (lyrics) {
    const dest = path.join(dir, 'lyrics.txt');
    const body = [title || '', youtubeUrl || '', '', lyrics].filter(Boolean).join('\n');
    await fsp.writeFile(dest, body, 'utf8');
    files.push(dest);
  }

  return { saved: true, dir, files };
}

module.exports = { saveLocally };
