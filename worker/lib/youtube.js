// worker/lib/youtube.js — upload the rendered mp4 + set the thumbnail.

const fs = require('fs');
const { google } = require('googleapis');

function ytClient(cfg) {
  if (!cfg.ytClientId || !cfg.ytClientSecret || !cfg.ytRefreshToken) {
    throw new Error('YouTube not connected (Settings → Connect YouTube channel)');
  }
  const oauth2 = new google.auth.OAuth2(cfg.ytClientId, cfg.ytClientSecret);
  oauth2.setCredentials({ refresh_token: cfg.ytRefreshToken });
  return google.youtube({ version: 'v3', auth: oauth2 });
}

function buildDescription({ title, lyrics, mood, styleTags }) {
  return [
    title, '',
    'An original AI-assisted song. Thanks for listening — like & subscribe for a new track every day.',
    '',
    mood ? `Mood: ${mood}` : '',
    styleTags ? `Style: ${styleTags}` : '',
    '',
    lyrics ? `Lyrics:\n${lyrics}` : '',
    '',
    '#music #originalsong #newmusic',
  ].join('\n').slice(0, 4900);
}

function buildTags({ styleTags, mood }) {
  const base = ['original song', 'new music', 'ai music', 'daily music'];
  const fromStyle = (styleTags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6);
  return [...new Set([...base, ...fromStyle, ...(mood ? [mood] : [])])].slice(0, 15);
}

/** @returns {Promise<{youtubeId, youtubeUrl}>} */
async function uploadToYoutube(cfg, { videoPath, imagePath, title, lyrics, mood, styleTags }) {
  const youtube = ytClient(cfg);

  const insert = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: String(title).slice(0, 95),
        description: buildDescription({ title, lyrics, mood, styleTags }),
        tags: buildTags({ styleTags, mood }),
        categoryId: '10', // Music
      },
      status: {
        privacyStatus: cfg.ytPrivacyStatus || 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: { body: fs.createReadStream(videoPath) },
  });

  const youtubeId = insert.data.id;
  if (!youtubeId) throw new Error('YouTube upload returned no video id');

  if (imagePath && fs.existsSync(imagePath)) {
    try {
      await youtube.thumbnails.set({
        videoId: youtubeId,
        media: { mimeType: 'image/png', body: fs.createReadStream(imagePath) },
      });
    } catch (e) {
      console.warn(`thumbnails.set failed (non-fatal): ${e.message}`);
    }
  }

  return { youtubeId, youtubeUrl: `https://www.youtube.com/watch?v=${youtubeId}` };
}

/**
 * Add an uploaded video to the configured playlist.
 * Requires the "youtube" scope - if the stored token predates it, reconnect
 * the channel from Settings.
 * @returns {Promise<{added: boolean, reason?: string}>}
 */
async function addToPlaylist(cfg, videoId) {
  const playlistId = cfg.ytPlaylistId;
  if (!playlistId) return { added: false, reason: 'no playlist configured' };
  try {
    const youtube = ytClient(cfg);
    await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
      },
    });
    return { added: true };
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    console.warn(`playlistItems.insert failed (non-fatal): ${reason}`);
    return { added: false, reason };
  }
}

module.exports = { uploadToYoutube, addToPlaylist };
