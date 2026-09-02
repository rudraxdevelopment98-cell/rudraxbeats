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


/**
 * Second pass shared by every "moving picture" mode: take a finished montage
 * (silent, 1080p30), loop it for the whole song, mux the audio and draw the
 * title. `waveform` adds the audio-reactive bar used by the AI-scene mode.
 */
async function muxMontage({ montage, audioFile, titleFile, outFile, title, titleRoman, waveform = false }) {
  const chosen = chooseTitle(title, titleRoman);
  const drawOverlay = HAS_DRAWTEXT && titleFile && chosen.text;
  if (drawOverlay) fsSync.writeFileSync(titleFile, sanitize(chosen.text));

  const args = ['-y', '-stream_loop', '-1', '-i', montage, '-i', audioFile];

  // Build the filter chain only when something actually needs filtering -
  // a plain copy of the video stream is faster and can never fail on fonts.
  const chain = [];
  let last = '0:v';
  if (waveform) {
    chain.push(`[1:a]showwaves=s=1920x220:mode=cline:rate=30:colors=white@0.55[wave]`);
    chain.push(`[${last}][wave]overlay=x=0:y=H-h-50[bgw]`);
    last = 'bgw';
  }
  if (drawOverlay) {
    chain.push(
      `[${last}]drawtext=fontfile='${chosen.font}':textfile='${titleFile}':fontcolor=white:` +
        `fontsize=64:box=1:boxcolor=black@0.45:boxborderw=24:x=(w-text_w)/2:y=90[v]`
    );
    last = 'v';
  }
  if (chain.length) {
    args.push('-filter_complex', chain.join(';'), '-map', `[${last}]`);
  } else {
    args.push('-map', '0:v');
  }
  args.push(
    '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart',
    outFile
  );
  await run(args);
}

/**
 * Build the video from real clips (e.g. made by hand in Flow AI) instead of a
 * still image.
 *
 * Two passes, because clips vary in size/codec/fps and are usually far shorter
 * than the song:
 *   1. normalise every clip to 1080p30 and concatenate them (no audio)
 *   2. loop that montage with -stream_loop and mux the song over it
 *
 * @returns {Promise<{durationSec:number, clipsUsed:number}>}
 */
async function renderVideoFromClips({ clipPaths, audioFile, titleFile, outFile, title, titleRoman, workDir }) {
  if (!clipPaths || clipPaths.length === 0) throw new Error('no clips supplied');
  const dur = (await probeDuration(audioFile)) || 150;
  const base = pathMod.join(workDir, 'montage.mp4');

  // --- pass 1: normalise + concat -----------------------------------------
  const inputs = [];
  const parts = [];
  clipPaths.forEach((clip, i) => {
    inputs.push('-i', clip);
    parts.push(
      `[${i}:v]scale=1920:1080:force_original_aspect_ratio=increase,` +
        `crop=1920:1080,setsar=1,fps=30,format=yuv420p[c${i}]`
    );
  });
  const concatIn = clipPaths.map((_, i) => `[c${i}]`).join('');
  const filter = `${parts.join(';')};${concatIn}concat=n=${clipPaths.length}:v=1:a=0[v]`;

  await run([
    '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[v]',
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    base,
  ]);

  // --- pass 2: loop to the song's length, add audio and the title ---------
  await muxMontage({ montage: base, audioFile, titleFile, outFile, title, titleRoman });

  return { durationSec: dur, clipsUsed: clipPaths.length };
}

// The working canvas for a moving shot: 1.25x of 1080p, which leaves room to
// zoom or pan without ever showing an edge.
const KB_W = 2400;
const KB_H = 1350;
const KB_RANGE = 0.18; // how far a shot zooms/pans over its whole length

// Ken-Burns motions, cycled so consecutive scenes never move the same way.
const KB_MOTIONS = ['zoom-in', 'pan-right', 'zoom-out', 'pan-left'];

/**
 * Turn one still image into a moving shot.
 *
 * Deliberately NOT ffmpeg's zoompan filter: zoompan re-scales the source for
 * every output frame and measured ~17x slower here than an animated
 * `scale=...:eval=frame` (a 4-scene video went from minutes to seconds), which
 * matters a lot on a home PC that also has to encode the song.
 */
async function makeKenBurnsClip({ imageFile, outFile, seconds = 8, motion = 'zoom-in', workDir }) {
  const dur = Math.max(2, seconds);
  const dir = workDir || pathMod.dirname(outFile);
  const base = pathMod.join(dir, `${pathMod.basename(outFile, pathMod.extname(outFile))}-base.png`);

  // Scale to the working canvas once, not once per frame.
  await run([
    '-y', '-i', imageFile,
    '-vf', `scale=${KB_W}:${KB_H}:force_original_aspect_ratio=increase,crop=${KB_W}:${KB_H}`,
    '-frames:v', '1', base,
  ]);

  const p = `min(1,t/${dur})`; // 0 -> 1 across the shot, clamped on the last frame
  let move;
  switch (motion) {
    case 'zoom-out':
      move =
        `scale=w='${KB_W}*(1+${KB_RANGE}*(1-${p}))':h='${KB_H}*(1+${KB_RANGE}*(1-${p}))':eval=frame,` +
        `crop=1920:1080:x='(iw-ow)/2':y='(ih-oh)/2'`;
      break;
    case 'pan-right':
      move = `crop=1920:1080:x='(iw-ow)*${p}':y='(ih-oh)/2'`;
      break;
    case 'pan-left':
      move = `crop=1920:1080:x='(iw-ow)*(1-${p})':y='(ih-oh)/2'`;
      break;
    case 'zoom-in':
    default:
      move =
        `scale=w='${KB_W}*(1+${KB_RANGE}*${p})':h='${KB_H}*(1+${KB_RANGE}*${p})':eval=frame,` +
        `crop=1920:1080:x='(iw-ow)/2':y='(ih-oh)/2'`;
  }

  await run([
    '-y',
    '-loop', '1', '-t', String(dur), '-i', base,
    '-filter_complex', `[0:v]${move},fps=30,setsar=1,format=yuv420p[v]`,
    '-map', '[v]',
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    outFile,
  ]);
  return outFile;
}

/**
 * Fully automatic music video: several AI-generated scene images, each given a
 * Ken-Burns move and cross-faded into the next, looped under the song.
 *
 * This is what makes the engine hands-free - no hand-made clips needed.
 *
 * @returns {Promise<{durationSec:number, scenesUsed:number}>}
 */
async function renderVideoFromScenes({
  imagePaths, audioFile, titleFile, outFile, title, titleRoman, workDir, sceneSeconds = 8,
}) {
  if (!imagePaths || imagePaths.length === 0) throw new Error('no scene images supplied');
  const dur = (await probeDuration(audioFile)) || 150;

  // --- pass 1a: one Ken-Burns clip per image ------------------------------
  const shots = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const out = pathMod.join(workDir, `scene-${i}.mp4`);
    await makeKenBurnsClip({
      imageFile: imagePaths[i], outFile: out, seconds: sceneSeconds,
      motion: KB_MOTIONS[i % KB_MOTIONS.length], workDir,
    });
    shots.push(out);
  }

  // --- pass 1b: cross-fade the shots into one montage ----------------------
  const base = pathMod.join(workDir, 'montage.mp4');
  const XF = 1.2; // cross-fade length in seconds
  if (shots.length === 1) {
    await fsSync.promises.copyFile(shots[0], base);
  } else {
    const inputs = [];
    shots.forEach((s) => inputs.push('-i', s));
    const steps = [];
    let cur = '[0:v]';
    let offset = sceneSeconds - XF;
    for (let i = 1; i < shots.length; i++) {
      const out = i === shots.length - 1 ? '[vout]' : `[x${i}]`;
      steps.push(`${cur}[${i}:v]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(2)}${out}`);
      cur = out;
      offset += sceneSeconds - XF;
    }
    const encode = ['-map', '[vout]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', base];
    try {
      await run(['-y', ...inputs, '-filter_complex', steps.join(';'), ...encode]);
    } catch (e) {
      // xfade is picky about odd input combinations; a hard cut still ships.
      console.warn(`scene cross-fade failed (${e.message.slice(0, 120)}), using hard cuts`);
      const cat = shots.map((_, i) => `[${i}:v]`).join('');
      await run([
        '-y', ...inputs,
        '-filter_complex', `${cat}concat=n=${shots.length}:v=1:a=0[vout]`,
        ...encode,
      ]);
    }
  }

  // --- pass 2: loop under the song, waveform + title ----------------------
  await muxMontage({ montage: base, audioFile, titleFile, outFile, title, titleRoman, waveform: true });

  return { durationSec: dur, scenesUsed: imagePaths.length };
}

/** Solid gradient fallback if no thumbnail was produced. */
async function makeFallbackImage(outFile) {
  await run([
    '-y', '-f', 'lavfi', '-i',
    'gradients=s=1920x1080:c0=0x101826:c1=0x2a1b4d:duration=1',
    '-frames:v', '1', outFile,
  ]);
}

module.exports = {
  renderVideo,
  renderVideoFromClips,
  renderVideoFromScenes,
  makeKenBurnsClip,
  makeFallbackImage,
  sanitize,
  probeDuration,
  ffmpegPath,
  HAS_DRAWTEXT,
  FONT_PATH,
  FONT_PATH_INDIC,
};
