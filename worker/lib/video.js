// worker/lib/video.js
// Builds the 1080p mp4: Ken-Burns still + waveform + (optional) title overlay.

const { spawn, execFileSync } = require('child_process');

const fsSync = require('fs');
const pathMod = require('path');

// Where to look for a real ffmpeg binary shipped alongside the app. This must
// cover the packaged desktop app (binary sits next to the launcher, while this
// file lives in lib/) as well as plain `npm start` and Docker.
const IS_PACKAGED = Boolean(process.pkg);
function appDirs() {
  const dirs = [];
  if (IS_PACKAGED) dirs.push(pathMod.dirname(process.execPath));
  try {
    if (require.main && require.main.filename) dirs.push(pathMod.dirname(require.main.filename));
  } catch (_) {}
  dirs.push(pathMod.join(__dirname, '..')); // app root when running from lib/
  dirs.push(__dirname);
  dirs.push(process.cwd());
  return [...new Set(dirs)];
}

function resolveBinary(envVar, systemName, staticResolver) {
  if (process.env[envVar]) return process.env[envVar];

  // 1. a binary shipped next to the app
  for (const dir of appDirs()) {
    for (const name of [`${systemName}.exe`, systemName]) {
      const candidate = pathMod.join(dir, name);
      try {
        if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()) return candidate;
      } catch (_) {}
    }
  }

  // 2. on PATH (`which` on macOS/Linux, `where` on Windows)
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(locator, [systemName], { encoding: 'utf8' })
      .split(/\r?\n/)[0]
      .trim();
    if (found) return found;
  } catch (_) {}

  // 3. the npm static binary - optional, and absent from the desktop bundle,
  //    so a missing module must never crash the worker.
  try {
    const p = staticResolver();
    if (p) return p;
  } catch (_) {}

  return systemName; // last resort: assume it is on PATH
}

const ffmpegPath = resolveBinary('FFMPEG_PATH', 'ffmpeg', () => require('ffmpeg-static'));

// The npm ffmpeg-static build lacks drawtext (no libfreetype); the Docker image
// installs a full ffmpeg. Detect and degrade gracefully.
let HAS_DRAWTEXT = false;
try {
  HAS_DRAWTEXT = /\bdrawtext\b/.test(
    execFileSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8' })
  );
} catch (_) {}

// Font selection. DejaVu has no Gujarati/Devanagari glyphs, so for Indic
// titles we look for a Noto font first (the Docker image installs fonts-noto-core)
// and fall back to the romanized title if no suitable font exists.
const INDIC = /[\u0A80-\u0AFF\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/;

const LATIN_FONTS = [
  process.env.FONT_PATH,
  // Linux (Docker image)
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  // Windows
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/segoeuib.ttf',
  // macOS
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial.ttf',
];
const INDIC_FONTS = [
  process.env.FONT_PATH_INDIC,
  // Linux (fonts-noto-core)
  '/usr/share/fonts/truetype/noto/NotoSansGujarati-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansGujarati-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  // Windows - Nirmala UI ships with Windows and covers Gujarati/Devanagari
  'C:/Windows/Fonts/NirmalaB.ttf',
  'C:/Windows/Fonts/Nirmala.ttf',
  'C:/Windows/Fonts/NotoSansGujarati-Regular.ttf',
  // macOS
  '/System/Library/Fonts/Supplemental/Gujarati Sangam MN.ttc',
  '/Library/Fonts/NotoSansGujarati-Regular.ttf',
];

const firstExisting = (list) => list.filter(Boolean).find((f) => { try { return fsSync.existsSync(f); } catch (_) { return false; } }) || null;

const FONT_PATH = firstExisting(LATIN_FONTS) || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_PATH_INDIC = firstExisting(INDIC_FONTS);

/**
 * Choose the overlay text + font: prefer the native-script title when a font
 * that can actually draw it is installed, else use the romanized title.
 */
function chooseTitle(title, titleRoman) {
  const native = String(title || '');
  if (INDIC.test(native)) {
    if (FONT_PATH_INDIC) return { text: native, font: FONT_PATH_INDIC };
    if (titleRoman) return { text: String(titleRoman), font: FONT_PATH };
    return { text: '', font: FONT_PATH }; // nothing safe to draw - skip overlay
  }
  return { text: native, font: FONT_PATH };
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}: ${err.slice(-800)}`))));
    p.on('error', reject);
  });
}

/**
 * Read an audio file's duration. We ask ffmpeg rather than shipping ffprobe:
 * `ffmpeg -i <file>` prints "Duration: HH:MM:SS.xx" on stderr, and skipping
 * ffprobe keeps the desktop app ~60 MB smaller.
 * @returns {Promise<number|null>} seconds
 */
function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    // ffmpeg exits non-zero when given no output file - that is expected here.
    p.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
      if (!m) return resolve(null);
      const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
      resolve(Number.isFinite(secs) ? secs : null);
    });
    p.on('error', () => resolve(null));
  });
}

const sanitize = (t) =>
  String(t || 'New Song').replace(/[\r\n]+/g, ' ').replace(/[%\\]/g, '').trim().slice(0, 80);

/** Render audio + still image into an mp4. Returns { durationSec }. */
async function renderVideo({ audioFile, imageFile, titleFile, outFile, title, titleRoman }) {
  const dur = (await probeDuration(audioFile)) || 150;
  const chosen = chooseTitle(title, titleRoman);
  const drawOverlay = HAS_DRAWTEXT && titleFile && chosen.text;
  if (drawOverlay) fsSync.writeFileSync(titleFile, sanitize(chosen.text));
  const zoomFrames = Math.ceil(dur * 30);

  const chain = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,` +
      `zoompan=z='min(zoom+0.0004,1.15)':d=${zoomFrames}:s=1920x1080:fps=30,setsar=1[bg]`,
    `[1:a]showwaves=s=1920x240:mode=cline:rate=30:colors=white@0.65[wave]`,
    `[bg][wave]overlay=x=0:y=H-h-60[bgw]`,
  ];
  if (drawOverlay) {
    chain.push(
      `[bgw]drawtext=fontfile='${chosen.font}':textfile='${titleFile}':fontcolor=white:` +
        `fontsize=64:box=1:boxcolor=black@0.45:boxborderw=24:x=(w-text_w)/2:y=90[v]`
    );
  } else {
    chain.push(`[bgw]null[v]`);
  }

  await run([
    '-y',
    '-loop', '1', '-i', imageFile,
    '-i', audioFile,
    '-filter_complex', chain.join(';'),
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart',
    outFile,
  ]);

  return { durationSec: dur };
}

/** Solid gradient fallback if no thumbnail was produced. */
async function makeFallbackImage(outFile) {
  await run([
    '-y', '-f', 'lavfi', '-i',
    'gradients=s=1920x1080:c0=0x101826:c1=0x2a1b4d:duration=1',
    '-frames:v', '1', outFile,
  ]);
}

module.exports = { renderVideo, makeFallbackImage, sanitize, ffmpegPath, HAS_DRAWTEXT, FONT_PATH, FONT_PATH_INDIC };
