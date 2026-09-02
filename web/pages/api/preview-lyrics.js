// pages/api/preview-lyrics.js
// GET (auth-guarded) -> generate ONE set of lyrics with the saved settings and
// return them, without running the rest of the pipeline.
//
// This is the fastest way to confirm the OpenAI key, the song language and the
// playlist subject are all working — an OpenAI call fits comfortably inside a
// serverless function, unlike the full pipeline.

import { requireAuth } from '../../lib/auth.js';
import { getConfig } from '../../lib/config.js';
import { generateLyrics } from '../../lib/lyrics.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  try {
    const cfg = await getConfig();
    const song = await generateLyrics(cfg);
    return res.status(200).json({
      ok: true,
      language: song.language,
      title: song.title,
      titleRoman: song.titleRoman || null,
      lyrics: song.lyrics,
      lyricsRoman: song.lyricsRoman || null,
      styleTags: song.style_tags,
      mood: song.mood,
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}
