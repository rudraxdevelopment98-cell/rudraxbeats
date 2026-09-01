// lib/youtube.js
// uploadToYoutube() - uploads the rendered mp4 to YouTube via the Data API v3
// using a long-lived OAuth2 refresh token, then sets the custom thumbnail.
//
// Scope required: https://www.googleapis.com/auth/youtube.upload
// (thumbnails.set also works under youtube.upload for videos you own.)

import { google } from 'googleapis';
import { Readable } from 'stream';

const CLIENT_ID = process.env.YT_CLIENT_ID;
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN;
const PRIVACY = process.env.YT_PRIVACY_STATUS || 'public';

function getYouTubeClient() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN must be set');
  }
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2 });
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
  const youtube = getYouTubeClient();

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
        privacyStatus: PRIVACY,
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
