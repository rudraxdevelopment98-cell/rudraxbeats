// worker/lib/clips.js
// Uses video clips the user made by hand (e.g. in Flow AI) as the visuals for
// a song, instead of the generated still image.
//
// Why a local folder and not Drive: the Drive connection uses the `drive.file`
// scope, which only ever sees files this app itself created — clips uploaded by
// hand would be invisible. The worker already runs on the PC where the clips
// are downloaded, so a plain folder is both simpler and permission-free.
//
// Layout (next to the app, or CLIPS_DIR):
//   clips/            <- drop new .mp4 files here
//   clips/used/       <- the worker moves them here after using them

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);

function appRoot() {
  if (process.env.CLIPS_DIR) return null; // explicit override wins
  if (process.pkg) return path.dirname(process.execPath);
  try {
    if (require.main && require.main.filename) return path.dirname(require.main.filename);
  } catch (_) {}
  return path.join(__dirname, '..');
}

function clipsDir() {
  return process.env.CLIPS_DIR || path.join(appRoot(), 'clips');
}

function usedDir() {
  return path.join(clipsDir(), 'used');
}

/** Create the folders (with a note) so the user can find where to drop clips. */
function ensureDirs() {
  const dir = clipsDir();
  try {
    fs.mkdirSync(usedDir(), { recursive: true });
    const readme = path.join(dir, 'PUT YOUR VIDEO CLIPS HERE.txt');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        [
          'Drop the video clips you made (Flow AI, etc.) into THIS folder.',
          '',
          'The engine picks the oldest clips first, loops them to the length of',
          'the song, and moves them into "used" afterwards so nothing repeats.',
          '',
          'If this folder is empty the engine still works — it falls back to the',
          'generated cover image with a waveform.',
          '',
          'Supported: .mp4 .mov .webm .mkv .m4v .avi',
        ].join('\n')
      );
    }
  } catch (_) {
    /* a read-only folder just means no clips - not fatal */
  }
  return dir;
}

/** Unused clips, oldest first (so the queue drains in the order you added). */
function listClips() {
  const dir = clipsDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => {
      const full = path.join(dir, e.name);
      let mtime = 0;
      let size = 0;
      try {
        const st = fs.statSync(full);
        mtime = st.mtimeMs;
        size = st.size;
      } catch (_) {}
      return { name: e.name, path: full, mtime, size };
    })
    .filter((c) => c.size > 0)
    .sort((a, b) => a.mtime - b.mtime);
}

function countClips() {
  return listClips().length;
}

/** Take up to `n` clips for one song (does not move them yet). */
function takeClips(n) {
  return listClips().slice(0, Math.max(1, n));
}

/** Move used clips into clips/used so they are never reused. */
async function markUsed(clips) {
  await fsp.mkdir(usedDir(), { recursive: true }).catch(() => {});
  for (const c of clips) {
    const target = path.join(usedDir(), c.name);
    try {
      await fsp.rename(c.path, target);
    } catch (_) {
      // Cross-device or name clash: fall back to copy + delete with a suffix.
      try {
        const alt = path.join(usedDir(), `${Date.now()}-${c.name}`);
        await fsp.copyFile(c.path, alt);
        await fsp.unlink(c.path);
      } catch (e) {
        console.warn(`could not archive clip ${c.name}: ${e.message}`);
      }
    }
  }
}

module.exports = { clipsDir, usedDir, ensureDirs, listClips, countClips, takeClips, markUsed };
