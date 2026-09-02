// worker/lib/video.js
// Builds the 1080p mp4: Ken-Burns still + waveform + (optional) title overlay.

const { spawn, execFileSync } = require('child_process');

function resolveBinary(envVar, systemName, staticResolver) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const found = execFileSync('which', [systemName], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch (_) {}
  return staticResolver();
}

const ffmpegPath = resolveBinary('FFMPEG_PATH', 'ffmpeg', () => require('ffmpeg-static'));
const ffprobePath = resolveBinary('FFPROBE_PATH', 'ffprobe', () => require('ffprobe-static').path);

// The npm ffmpeg-static build lacks drawtext (no libfreetype); the Docker image
// installs a full ffmpeg. Detect and degrade gracefully.
let HAS_DRAWTEXT = false;
try {
  HAS_DRAWTEXT = /\bdrawtext\b/.test(
    execFileSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8' })
  );
} catch (_) {}

const FONT_PATH = process.env.FONT_PATH || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}: ${err.slice(-800)}`))));
    p.on('error', reject);
  });
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { const n = parseFloat(out.trim()); resolve(Number.isFinite(n) ? n : null); });
    p.on('error', () => resolve(null));
  });
}

const sanitize = (t) =>
  String(t || 'New Song').replace(/[\r\n]+/g, ' ').replace(/[%\\]/g, '').trim().slice(0, 80);

/** Render audio + still image into an mp4. Returns { durationSec }. */
async function renderVideo({ audioFile, imageFile, titleFile, outFile, title }) {
  const dur = (await probeDuration(audioFile)) || 150;
  const zoomFrames = Math.ceil(dur * 30);

  const chain = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,` +
      `zoompan=z='min(zoom+0.0004,1.15)':d=${zoomFrames}:s=1920x1080:fps=30,setsar=1[bg]`,
    `[1:a]showwaves=s=1920x240:mode=cline:rate=30:colors=white@0.65[wave]`,
    `[bg][wave]overlay=x=0:y=H-h-60[bgw]`,
  ];
  if (HAS_DRAWTEXT && titleFile) {
    chain.push(
      `[bgw]drawtext=fontfile='${FONT_PATH}':textfile='${titleFile}':fontcolor=white:` +
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

module.exports = { renderVideo, makeFallbackImage, sanitize, ffmpegPath, HAS_DRAWTEXT };
