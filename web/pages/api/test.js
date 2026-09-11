// pages/api/test.js
// GET ?target=lyrics|song|cover|video|upload|storage   (auth-guarded)
//
// One test per pipeline node, and each one does the node's REAL job rather
// than checking that a key parses: the lyrics test writes lyrics, the cover
// test paints an image, the upload test asks YouTube which channel it controls.
// A green tick here means that stage will work tonight.
//
// Every test returns { ok, message, detail?, sample?, image? } and never throws.

import { google } from 'googleapis';
import { requireAuth } from '../../lib/auth.js';
import { getConfig } from '../../lib/config.js';
import { getWorkerHeartbeat } from '../../lib/db.js';
import { generateImage } from '../../lib/geminiImage.js';
import { chat, lyricsProvider } from '../../lib/llmChat.js';

// ---------------------------------------------------------------- lyrics ---
async function testLyrics(c) {
  const provider = lyricsProvider(c);
  const language = c.songLanguage || 'English';
  const nonLatin = /^(gujarati|hindi|marathi|bengali|punjabi|tamil|telugu|kannada|malayalam|odia|urdu|nepali)$/i.test(language);

  try {
    const { text, model, usage } = await chat(c, {
      system: `You are a ${language} songwriter. Reply with the lines only.`,
      user:
        `Write two original lines of a ${language} song about ${c.playlistTopic || 'a village evening'}. ` +
        (nonLatin ? 'Write them in the native script, then the same two lines romanized on the next line.' : ''),
      maxTokens: 200,
    });
    return {
      ok: true,
      message: `${model} wrote real ${language} lines ✓`,
      detail: `Provider: ${provider}${usage ? ` · tokens used: ${usage}` : ''}`,
      sample: text,
    };
  } catch (e) {
    const msg = e.message || String(e);
    let hint = '';
    if (/429|quota|credit_balance_exhausted|RESOURCE_EXHAUSTED/i.test(msg)) {
      hint = provider === 'openai'
        ? ' This OpenAI account has no credit left. Switch the provider to Gemini (free) on this page, or add credit.'
        : ' The Gemini free tier is used up for now — it resets on its own; try again later.';
    } else if (/API key not valid|401|invalid_api_key/i.test(msg)) {
      hint = ' Check the key was copied whole.';
    }
    return { ok: false, message: `${provider === 'openai' ? 'OpenAI' : 'Gemini'} could not write lyrics.${hint}`, detail: msg.slice(0, 300) };
  }
}

// ------------------------------------------------------------------ song ---
async function testSong(c) {
  const base = (c.sunoBaseUrl || '').replace(/\/$/, '');
  if (!base) return { ok: false, message: 'No Suno wrapper URL set.' };
  const headers = c.sunoApiKey ? { Authorization: `Bearer ${c.sunoApiKey}` } : {};

  if ((c.sunoMode || 'suno-api') !== 'suno-api') {
    try {
      const r = await fetch(base, { headers });
      return { ok: r.ok, message: r.ok ? 'Wrapper reachable ✓' : `Wrapper returned ${r.status}.` };
    } catch (e) {
      return { ok: false, message: `Cannot reach the wrapper: ${e.message}` };
    }
  }

  try {
    const r = await fetch(`${base}/api/get_limit`, { headers });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, message: `Suno rejected the session (${r.status}). Paste a fresh SUNO_COOKIE in the wrapper.` };
    }
    if (!r.ok) return { ok: false, message: `Wrapper returned ${r.status}. Is it deployed and awake?` };
    const d = await r.json().catch(() => ({}));
    const credits = d.credits_left ?? d.credits ?? d.remaining ?? null;
    if (credits == null) {
      return { ok: false, message: 'Wrapper answered without a credit count — check SUNO_COOKIE.', detail: JSON.stringify(d).slice(0, 200) };
    }
    const songs = Math.floor(Number(credits) / 10); // a Suno generation costs ~10 credits
    return {
      ok: Number(credits) > 0,
      message: Number(credits) > 0
        ? `Cookie is alive ✓ — ${credits} credits left (~${songs} songs)`
        : 'Connected, but there are no credits left on this Suno account.',
      detail: d.monthly_limit ? `Monthly limit: ${d.monthly_limit}` : undefined,
    };
  } catch (e) {
    return { ok: false, message: `Cannot reach the wrapper: ${e.message}` };
  }
}

// ----------------------------------------------------------------- cover ---
async function testCover(c) {
  if (!c.geminiApiKey) return { ok: false, message: 'No Gemini key set.' };
  try {
    const img = await generateImage(
      c.geminiApiKey,
      `Album cover for a ${c.songLanguage || ''} song about ${c.playlistTopic || 'a village evening'}. ` +
        'Cinematic lighting, bold subject, 16:9, no text, no watermark.',
      c.geminiImageModel
    );
    return {
      ok: true,
      message: `Real image generated ✓ (model: ${img.model})`,
      detail: 'This is exactly what a song would get as its cover.',
      image: `data:${img.mimeType};base64,${img.base64}`,
    };
  } catch (e) {
    const msg = e.message || String(e);
    const hint = /429|RESOURCE_EXHAUSTED/i.test(msg)
      ? ' The key is out of quota for today.'
      : /API key not valid|400/i.test(msg)
        ? ' Check the key was copied whole.'
        : '';
    return { ok: false, message: `Gemini could not make an image.${hint}`, detail: msg.slice(0, 300) };
  }
}

// ----------------------------------------------------------------- video ---
async function testVideo(c) {
  const hb = await getWorkerHeartbeat();
  if (!hb.online) {
    return {
      ok: false,
      message: hb.info
        ? `Worker last checked in ${hb.ageSec}s ago — it is not running now.`
        : 'No worker has ever connected. Install the worker app on the PC.',
    };
  }
  const i = hb.info || {};
  const bits = [
    `platform: ${i.platform || '?'}`,
    `ffmpeg: ${i.ffmpeg ? 'found' : 'see the worker window'}`,
    i.drawtext === false ? 'title overlay: off (ffmpeg without drawtext)' : 'title overlay: on',
    i.indicFont === false ? 'Gujarati font: missing (romanized titles)' : 'Gujarati font: ok',
    `clips waiting: ${i.clipsAvailable ?? 0}`,
  ];
  const mode = c.videoMode || 'auto';
  return {
    ok: true,
    message: `Worker online ✓ — mode: ${mode === 'poster' ? 'poster (cover + audio)' : mode}`,
    detail: bits.join(' · '),
  };
}

// ---------------------------------------------------------------- upload ---
function googleAuth(c, refreshToken) {
  const oauth2 = new google.auth.OAuth2(c.ytClientId, c.ytClientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

const expiredHint =
  'The Google login has expired. Reconnect it in Settings — and publish your OAuth consent ' +
  'screen (Google Cloud → APIs & Services → OAuth consent screen → Publish), because a ' +
  '“Testing” app expires the login every 7 days.';

async function testUpload(c) {
  if (!c.ytClientId || !c.ytClientSecret || !c.ytRefreshToken) {
    return { ok: false, message: 'YouTube is not connected. Use Connect YouTube in Settings.' };
  }
  try {
    const youtube = google.youtube({ version: 'v3', auth: googleAuth(c, c.ytRefreshToken) });
    const me = await youtube.channels.list({ part: ['snippet', 'statistics'], mine: true });
    const ch = me.data.items?.[0];
    if (!ch) return { ok: false, message: 'Connected, but this login controls no channel.' };

    const parts = [`Uploads go to “${ch.snippet?.title}”`, `privacy: ${c.ytPrivacyStatus || 'public'}`];
    let ok = true;

    if (c.ytPlaylistId) {
      const id = (c.ytPlaylistId.match(/[?&]list=([A-Za-z0-9_-]+)/) || [])[1] || c.ytPlaylistId;
      const pl = await youtube.playlists.list({ part: ['snippet'], id: [id] });
      const found = pl.data.items?.[0];
      if (found) parts.push(`playlist: “${found.snippet?.title}”`);
      else {
        ok = false;
        parts.push(`playlist id “${id}” was not found on this account`);
      }
    } else {
      parts.push('no playlist set — uploads just go to the channel');
    }

    return { ok, message: ok ? 'YouTube ready ✓' : 'Channel is fine, but the playlist is wrong.', detail: parts.join(' · ') };
  } catch (e) {
    const msg = String(e?.response?.data?.error?.message || e.message || e);
    if (/invalid_grant|unauthorized/i.test(msg)) return { ok: false, message: expiredHint };
    return { ok: false, message: `YouTube refused: ${msg.slice(0, 200)}` };
  }
}

// --------------------------------------------------------------- storage ---
async function testStorage(c) {
  const local = c.localSavePath
    ? `PC folder: ${c.localSavePath}`
    : 'PC folder: a “Songs” folder next to the worker app';

  if (!c.driveRefreshToken) {
    return {
      ok: true,
      message: 'Drive is not connected — songs are still saved on the worker PC ✓',
      detail: local,
    };
  }
  try {
    const drive = google.drive({ version: 'v3', auth: googleAuth(c, c.driveRefreshToken) });
    const name = c.driveFolderName || 'AI Song Engine';
    const q = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
    const folders = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 });
    const folder = folders.data.files?.[0];
    if (!folder) {
      return { ok: true, message: 'Drive connected ✓ — the folder is created with the first song.', detail: local };
    }
    const files = await drive.files.list({
      q: `'${folder.id}' in parents and trashed=false`,
      fields: 'files(id,name)',
      pageSize: 100,
    });
    const n = files.data.files?.length || 0;
    return {
      ok: true,
      message: `Drive connected ✓ — “${name}” holds ${n} file(s)`,
      detail: `${local} · keeping the newest ${c.driveKeepSongs || 4} songs in Drive`,
    };
  } catch (e) {
    const msg = String(e?.response?.data?.error?.message || e.message || e);
    if (/invalid_grant|unauthorized/i.test(msg)) return { ok: false, message: expiredHint };
    return { ok: false, message: `Drive refused: ${msg.slice(0, 200)}`, detail: local };
  }
}

const TESTS = {
  lyrics: testLyrics,
  song: testSong,
  cover: testCover,
  video: testVideo,
  upload: testUpload,
  storage: testStorage,
  // older names used by the Settings page
  openai: testLyrics,
  suno: testSong,
  gemini: testCover,
  worker: testVideo,
};

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  try {
    const c = await getConfig();
    const fn = TESTS[String(req.query.target || '')];
    if (!fn) return res.status(400).json({ error: 'Unknown target' });
    return res.status(200).json(await fn(c));
  } catch (err) {
    return res.status(200).json({ ok: false, message: err.message });
  }
}
