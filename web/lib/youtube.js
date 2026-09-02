// lib/youtube.js
// uploadToYoutube() - uploads the rendered mp4 to YouTube via the Data API v3
// using a long-lived OAuth2 refresh token, then sets the custom thumbnail.
//
// Scope required: https://www.googleapis.com/auth/youtube (see YT_SCOPES).

import { google } from 'googleapis';
import { Readable } from 'stream';
import { getConfig } from './config.js';

// Google refuses a consent request that mixes YouTube scopes with ANY other
// Google API scope (and refuses mixing youtube.upload with youtube). So we run
// TWO separate consent flows and store TWO refresh tokens:
//   - YouTube: the single broad `youtube` scope covers videos.insert (upload),
//     thumbnails.set, channels.list(mine) and playlistItems.insert.
//   - Drive:   `drive.file` - only files this app itself creates.
export const YT_SCOPES = ['https://www.googleapis.com/auth/youtube'];
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

/** Scope set for a given connect flow. */
export function scopesFor(service) {
  return service === 'drive' ? DRIVE_SCOPES : YT_SCOPES;
}

function getYouTubeClient(cfg) {
  if (!cfg.ytClientId || !cfg.ytClientSecret || !cfg.ytRefreshToken) {
    throw new Error(
      'YouTube client id/secret/refresh token must be set (Settings > YouTube upload)'
    );
  }
  const oauth2 = new google.auth.OAuth2(cfg.ytClientId, cfg.ytClientSecret);
  oauth2.setCredentials({ refresh_token: cfg.ytRefreshToken });
  return google.youtube({ version: 'v3', auth: oauth2 });
}

// --- OAuth (in-app "Connect YouTube") --------------------------------------

function oauthClient(cfg, redirectUri) {
  return new google.auth.OAuth2(cfg.ytClientId, cfg.ytClientSecret, redirectUri);
}

/**
 * Build the Google consent URL. `select_account` lets the user CHOOSE which
 * Google account / channel to grant access to; `offline` + `consent` ensure
 * a refresh_token is always returned.
 */
export function buildConsentUrl(cfg, redirectUri, service = 'youtube') {
  return oauthClient(cfg, redirectUri).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: scopesFor(service),
    // Must stay false: including previously granted scopes would re-mix
    // YouTube and Drive scopes and trigger Google's "cannot be requested
    // together" error again.
    include_granted_scopes: false,
    state: service,
  });
}

/** Exchange an auth code for tokens (contains refresh_token). */
export async function exchangeCodeForTokens(cfg, redirectUri, code) {
  const { tokens } = await oauthClient(cfg, redirectUri).getToken(code);
  return tokens;
}

/**
 * Fetch the connected channel's identity so the UI can show who has access.
 * @returns {Promise<{id, title, thumbnail}|null>}
 */
export async function getConnectedChannel() {
  const cfg = await getConfig();
  if (!cfg.ytClientId || !cfg.ytClientSecret || !cfg.ytRefreshToken) return null;
  const youtube = getYouTubeClient(cfg);
  const res = await youtube.channels.list({ part: ['snippet'], mine: true });
  const ch = res.data.items?.[0];
  if (!ch) return null;
  return {
    id: ch.id,
    title: ch.snippet?.title || '(unknown channel)',
    thumbnail: ch.snippet?.thumbnails?.default?.url || null,
  };
}

async function fetchToStream(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download video for upload (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { stream: Readable.from(buf), size: buf.length };
}

// Keep some human-ish variation in metadata to avoid a spammy, identical
// footprint across every upload (a YouTube reach/monetization risk).
function buildDescription({ title, lyrics, mood, styleTags }) {
  const parts = [
    `${title}`,
    '',
    'An original AI-assisted song. Thanks for listening — like & subscribe for a new track every day.',
    '',
    mood ? `Mood: ${mood}` : '',
    styleTags ? `Style: ${styleTags}` : '',
    '',
    lyrics ? 'Lyrics:\n' + lyrics : '',
    '',
    '#music #originalsong #newmusic',
  ];
  return parts.filter((p) => p !== null && p !== undefined).join('\n').slice(0, 4900);
}

function buildTags({ styleTags, mood }) {
  const base = ['original song', 'new music', 'ai music', 'daily music'];
  const fromStyle = (styleTags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
  const fromMood = mood ? [mood] : [];
  return [...new Set([...base, ...fromStyle, ...fromMood])].slice(0, 15);
}

/**
 * @param {object} args
 * @param {string} args.videoUrl         public mp4 URL from the worker
 * @param {string} args.title
 * @param {string} [args.lyrics]
 * @param {string} [args.mood]
 * @param {string} [args.styleTags]
 * @param {string} [args.thumbnailBase64] optional custom thumbnail
 * @returns {Promise<{youtubeId:string, youtubeUrl:string}>}
 */
export async function uploadToYoutube({
  videoUrl,
  title,
  lyrics,
  mood,
  styleTags,
  thumbnailBase64,
}) {
  const cfg = await getConfig();
  const youtube = getYouTubeClient(cfg);

  const { stream } = await fetchToStream(videoUrl);

  const insertRes = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title.slice(0, 95),
        description: buildDescription({ title, lyrics, mood, styleTags }),
        tags: buildTags({ styleTags, mood }),
        categoryId: '10', // Music
      },
      status: {
        privacyStatus: cfg.ytPrivacyStatus || 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: { body: stream },
  });

  const youtubeId = insertRes.data.id;
  if (!youtubeId) throw new Error('YouTube upload returned no video id');

  // Set custom thumbnail (best-effort - requires a verified channel).
  if (thumbnailBase64) {
    try {
      await youtube.thumbnails.set({
        videoId: youtubeId,
        media: {
          mimeType: 'image/png',
          body: Readable.from(Buffer.from(thumbnailBase64, 'base64')),
        },
      });
    } catch (e) {
      // Non-fatal: unverified channels can't set custom thumbnails.
      console.warn(`thumbnails.set failed (non-fatal): ${e.message}`);
    }
  }

  return {
    youtubeId,
    youtubeUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
  };
}
