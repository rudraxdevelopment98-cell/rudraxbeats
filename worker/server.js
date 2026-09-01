// worker/server.js
// Always-on render worker. Exposes POST /render (bearer-protected) which:
//   1. downloads the generated song audio
//   2. writes the thumbnail image to disk
//   3. builds a 1920x1080 mp4 with ffmpeg: Ken-Burns still background +
//      a waveform overlay + the song title as a text overlay
//   4. uploads the mp4 to storage and returns a public { videoUrl }
//
// Storage: if BLOB_READ_WRITE_TOKEN is set it uploads to Vercel Blob and
// returns that public URL. Otherwise it saves under /output and serves it
// statically at ${PUBLIC_BASE_URL}/output/<file>.mp4 (works out of the box on
// Railway/Render since the service already has a public URL).

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { execFileSync } = require('child_process');

// Resolve ffmpeg/ffprobe binaries. Prefer a full system build (the Docker
// image installs one via apt) because it includes the `drawtext` filter
// (libfreetype), which the npm `ffmpeg-static` prebuilt binary does NOT.
// Fall back to the static binaries when no system ffmpeg is present.
function resolveBinary(envVar, systemName, staticResolver) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const found = execFileSync('which', [systemName], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch (_) {
    /* not on PATH */
  }
  return staticResolver();
}

const ffmpegPath = resolveBinary('FFMPEG_PATH', 'ffmpeg', () => require('ffmpeg-static'));
const ffprobePath = resolveBinary(
  'FFPROBE_PATH',
  'ffprobe',
  () => require('ffprobe-static').path
);

// Does this ffmpeg build support drawtext? If not we skip the title overlay
// (the title still lands in the YouTube metadata + thumbnail).
let HAS_DRAWTEXT = false;
try {
  const filters = execFileSync(ffmpegPath, ['-hide_banner', '-filters'], {
    encoding: 'utf8',
  });
  HAS_DRAWTEXT = /\bdrawtext\b/.test(filters);
} catch (_) {
  HAS_DRAWTEXT = false;
}

const PORT = process.env.PORT || 3001;
const WORKER_SECRET = process.env.WORKER_SECRET;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
// Public base URL of THIS worker (used only for the local-storage fallback).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const FONT_PATH =
  process.env.FONT_PATH || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const OUTPUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '25mb' })); // thumbnails arrive as base64

// Serve rendered files for the local-storage fallback.
app.use('/output', express.static(OUTPUT_DIR, { maxAge: '1h' }));

app.get('/', (_req, res) => res.json({ ok: true, service: 'ai-song-engine-worker' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

function authorized(req) {
  if (!WORKER_SECRET) return false; // refuse if not configured
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${WORKER_SECRET}`;
}

// --- helpers ---------------------------------------------------------------

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return dest;
}

function probeDurationSec(file) {
  return new Promise((resolve) => {
    const p = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) ? n : null);
    });
    p.on('error', () => resolve(null));
  });
}

// Strip characters that would break ffmpeg's drawtext parsing. We pass the
// title through a textfile (below) which avoids most escaping, but keep it
// tidy anyway.
function sanitizeTitle(t) {
  return String(t || 'New Song')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[%\\]/g, '')
    .trim()
    .slice(0, 80);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-1200)}`));
    });
    p.on('error', reject);
  });
}

async function buildVideo({ audioFile, imageFile, titleFile, outFile, durationSec }) {
  const dur = durationSec && durationSec > 0 ? durationSec : 150;

  // Ken Burns (slow zoom) on the still, waveform overlay near the bottom,
  // title text at the top. 30fps, 1080p, h264 + aac, faststart for streaming.
  const zoomFrames = Math.ceil(dur * 30);
  const chain = [
    // scale/crop bg to 1080p then slow zoom (Ken Burns)
    `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,` +
      `zoompan=z='min(zoom+0.0004,1.15)':d=${zoomFrames}:s=1920x1080:fps=30,` +
      `setsar=1[bg]`,
    // waveform from the audio
    `[1:a]showwaves=s=1920x240:mode=cline:rate=30:colors=white@0.65[wave]`,
    // overlay waveform near the bottom
    `[bg][wave]overlay=x=0:y=H-h-60[bgw]`,
  ];

  if (HAS_DRAWTEXT) {
    // title text (read from a file to avoid escaping headaches)
    chain.push(
      `[bgw]drawtext=fontfile='${FONT_PATH}':textfile='${titleFile}':` +
        `fontcolor=white:fontsize=64:box=1:boxcolor=black@0.45:boxborderw=24:` +
        `x=(w-text_w)/2:y=90[v]`
    );
  } else {
    // No drawtext in this ffmpeg build - pass the composited frame through.
    chain.push(`[bgw]null[v]`);
  }

  const filter = chain.join(';');

  const args = [
    '-y',
    '-loop', '1', '-i', imageFile,
    '-i', audioFile,
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '1:a',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    outFile,
  ];

  await runFfmpeg(args);
}

async function storeVideo(outFile, id) {
  if (BLOB_TOKEN) {
    const { put } = require('@vercel/blob');
    const data = await fsp.readFile(outFile);
    const blob = await put(`songs/${id}.mp4`, data, {
      access: 'public',
      contentType: 'video/mp4',
      token: BLOB_TOKEN,
    });
    return blob.url;
  }
  // local fallback
  const publicName = `${id}.mp4`;
  const dest = path.join(OUTPUT_DIR, publicName);
  if (path.resolve(outFile) !== path.resolve(dest)) {
    await fsp.copyFile(outFile, dest);
  }
  if (!PUBLIC_BASE_URL) {
    throw new Error(
      'No BLOB_READ_WRITE_TOKEN and no PUBLIC_BASE_URL set - cannot produce a ' +
        'public video URL. Set one of them (see README).'
    );
  }
  return `${PUBLIC_BASE_URL}/output/${publicName}`;
}

// --- route -----------------------------------------------------------------

app.post('/render', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { audioUrl, title, thumbnailBase64, durationSec } = req.body || {};
  if (!audioUrl) return res.status(400).json({ error: 'audioUrl is required' });

  const id = crypto.randomBytes(8).toString('hex');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), `render-${id}-`));
  const audioFile = path.join(work, 'audio.mp3');
  const imageFile = path.join(work, 'image.png');
  const titleFile = path.join(work, 'title.txt');
  const outFile = path.join(work, 'out.mp4');

  try {
    await downloadTo(audioUrl, audioFile);

    if (thumbnailBase64) {
      await fsp.writeFile(imageFile, Buffer.from(thumbnailBase64, 'base64'));
    } else {
      // Fallback: a solid dark gradient background if no thumbnail was sent.
      await runFfmpeg([
        '-y', '-f', 'lavfi', '-i',
        'gradients=s=1920x1080:c0=0x101826:c1=0x2a1b4d:duration=1',
        '-frames:v', '1', imageFile,
      ]);
    }

    await fsp.writeFile(titleFile, sanitizeTitle(title));

    const dur = durationSec || (await probeDurationSec(audioFile));
    await buildVideo({ audioFile, imageFile, titleFile, outFile, durationSec: dur });

    const videoUrl = await storeVideo(outFile, id);

    res.json({ ok: true, videoUrl, durationSec: dur });
  } catch (err) {
    console.error(`[render ${id}] error:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // best-effort cleanup of the temp workdir
    fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`ai-song-engine worker listening on :${PORT}`);
  console.log(`ffmpeg: ${ffmpegPath} (drawtext: ${HAS_DRAWTEXT ? 'yes' : 'no - title overlay skipped'})`);
  console.log(`storage: ${BLOB_TOKEN ? 'Vercel Blob' : 'local /output (needs PUBLIC_BASE_URL)'}`);
});
