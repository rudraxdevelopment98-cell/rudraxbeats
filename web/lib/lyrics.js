// lib/lyrics.js
// generateLyrics() - calls the OpenAI Chat Completions API and returns a
// structured object: { title, lyrics, style_tags, mood }.
//
// To keep the channel from looking like mass-produced identical content
// (a YouTube monetization risk flagged in the README), we seed each run
// with a randomly picked theme + genre so titles/moods/styles vary.

import { getConfig } from './config.js';

const THEMES = [
  'late-night city drive', 'first snow of winter', 'chasing a distant dream',
  'reconnecting with an old friend', 'the calm after a storm', 'summer road trip',
  'letting go and moving on', 'small victories', 'a quiet morning with coffee',
  'homesickness', 'falling in love again', 'starting over in a new city',
  'gratitude at sunset', 'dancing in the rain', 'the last day of school',
  'midnight thoughts', 'finding light in the dark', 'ocean and open sky',
];

const GENRES = [
  'lo-fi chill', 'acoustic pop', 'indie folk', 'synthwave', 'soft R&B',
  'uplifting EDM', 'ambient piano', 'reggae groove', 'country ballad',
  'dream pop', 'hip-hop instrumental with hook', 'orchestral cinematic',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * @param {object} [opts]
 * @param {string} [opts.theme]  override the random theme
 * @param {string} [opts.genre]  override the random genre
 * @param {string} [opts.language='English']
 * @returns {Promise<{title:string, lyrics:string, style_tags:string, mood:string}>}
 */
export async function generateLyrics(opts = {}) {
  const cfg = await getConfig();
  const apiKey = cfg.openaiApiKey;
  const OPENAI_BASE_URL = cfg.openaiBaseUrl || 'https://api.openai.com/v1';
  const OPENAI_MODEL = cfg.openaiModel || 'gpt-4o-mini';
  if (!apiKey) throw new Error('OpenAI API key is not set (Settings > Lyrics)');

  const theme = opts.theme || pick(THEMES);
  const genre = opts.genre || pick(GENRES);
  const language = opts.language || 'English';

  const system = [
    'You are a professional songwriter and music producer.',
    'You write original, radio-friendly song lyrics and produce clean JSON.',
    'Never include copyrighted lyrics or reference real artists/songs.',
  ].join(' ');

  const user = [
    `Write an original ${genre} song in ${language} about "${theme}".`,
    'Structure it with clear sections labelled like [Verse 1], [Chorus], [Verse 2], [Bridge], [Outro].',
    'Keep it under ~2:30 of singing when performed.',
    '',
    'Respond with ONLY a JSON object (no markdown fences) with these keys:',
    '{',
    '  "title": short catchy song title (max 60 chars),',
    '  "lyrics": the full lyrics as a single string with \\n line breaks and section labels,',
    '  "style_tags": comma-separated production/style tags for a music AI (e.g. "lo-fi, warm, mellow, female vocals, 90 bpm"),',
    '  "mood": one or two words describing the mood',
    '}',
  ].join('\n');

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.9,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI lyrics request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned no content for lyrics');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Some models wrap JSON in fences despite instructions; strip and retry.
    const cleaned = content.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  }

  const title = String(parsed.title || `Untitled (${theme})`).slice(0, 100);
  const lyrics = String(parsed.lyrics || '').trim();
  const style_tags = String(parsed.style_tags || genre);
  const mood = String(parsed.mood || 'reflective');

  if (!lyrics) throw new Error('OpenAI returned empty lyrics');

  return { title, lyrics, style_tags, mood, theme, genre };
}
