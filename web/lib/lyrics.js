// lib/lyrics.js
// generateLyrics() — the SAME logic the worker uses, so the dashboard's
// "Preview lyrics" button shows exactly what a real run would produce.
// Keep this in sync with worker/lib/steps.js.
//
// For non-Latin languages (Gujarati and other Indic scripts) it returns BOTH
// the native script and a romanized transliteration: music models pronounce
// Indic lyrics far better from Latin script, while the native script is used
// for the YouTube title/description and the on-screen title.

const THEMES = [
  'late-night city drive', 'first snow of winter', 'chasing a distant dream',
  'reconnecting with an old friend', 'the calm after a storm', 'summer road trip',
  'letting go and moving on', 'small victories', 'a quiet morning with coffee',
  'homesickness', 'falling in love again', 'starting over in a new city',
  'gratitude at sunset', 'dancing in the rain', 'the last day of school',
  'midnight thoughts', 'finding light in the dark', 'ocean and open sky',
];

// Culturally-grounded fallback themes for Gujarati / Indian-language channels.
const THEMES_GU = [
  'Navratri nights and the garba circle', 'a village fair (melo)',
  'missing home while working far away', 'monsoon over the fields',
  'a mother\'s love', 'friendship that survived the years',
  'first love at a wedding', 'the Narmada river at dawn',
  'a farmer\'s hope after the rains', 'Diwali lights and family',
  'leaving the village for the city', 'devotion and inner peace',
  'a sister\'s vidaai', 'the joy of a good harvest',
];

const GENRES = [
  'lo-fi chill', 'acoustic pop', 'indie folk', 'synthwave', 'soft R&B',
  'uplifting EDM', 'ambient piano', 'reggae groove', 'country ballad',
  'dream pop', 'hip-hop instrumental with hook', 'orchestral cinematic',
];

// Gujarati / Indian genre palette - these read far better to a music model
// than western tags when the vocal language is Gujarati.
const GENRES_GU = [
  'traditional garba with dhol and tabla',
  'high-energy dandiya raas',
  'modern Gujarati folk pop with dholak',
  'soulful Gujarati romantic ballad with flute',
  'devotional bhajan with harmonium and tabla',
  'sufi-style Gujarati song with harmonium',
  'Gujarati folk (lokgeet) with manjira and dhol',
  'upbeat Gujarati wedding dance track',
  'semi-classical Gujarati melody with sitar',
  'acoustic Gujarati indie pop with guitar',
];

// Angles keep every song on the playlist's subject while staying distinct,
// so the channel doesn't look like mass-produced near-duplicates.
const ANGLES = [
  'a personal memory', 'a hopeful promise', 'a bittersweet goodbye',
  'a celebration', 'a quiet reflection', 'an energetic anthem',
  'a letter to someone', 'a sunrise beginning', 'a late-night confession',
  'a story told over one day', 'gratitude', 'overcoming a setback',
];

// Languages that use a non-Latin script: a music model sings these far more
// accurately from a romanized (Latin) transliteration than from the native
// script, so we ask for both and send the romanized version to Suno.
const NON_LATIN = [
  'gujarati', 'hindi', 'marathi', 'bengali', 'punjabi', 'tamil', 'telugu',
  'kannada', 'malayalam', 'odia', 'urdu', 'nepali', 'sanskrit', 'assamese',
];
const isNonLatin = (lang) => NON_LATIN.includes(String(lang || '').trim().toLowerCase());
const isGujaratiLike = (lang) => isNonLatin(lang);

const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------------------------------------------------------------- lyrics ---
export async function generateLyrics(cfg) {
  if (!cfg.openaiApiKey) throw new Error('OpenAI API key is not set (Settings → Lyrics)');

  const language = cfg.songLanguage || 'English';
  const nonLatin = isNonLatin(language);
  const genre = pick(nonLatin ? GENRES_GU : GENRES);

  // If a playlist subject/category is configured, every song is written about
  // that subject (with an angle picked per run so tracks aren't near-duplicates).
  // Otherwise fall back to a random theme suited to the language.
  const topic = String(cfg.playlistTopic || '').trim();
  const theme = topic
    ? `${topic} — a fresh angle: ${pick(ANGLES)}`
    : pick(nonLatin ? THEMES_GU : THEMES);

  // For non-Latin languages we also ask for a romanized transliteration: music
  // models pronounce Indic lyrics far better from Latin script. The native
  // script is kept for the YouTube title/description.
  const jsonSpec = nonLatin
    ? [
        'Respond with ONLY a JSON object with these keys:',
        '{',
        `  "title": short catchy title in ${language} script (max 60 chars),`,
        '  "title_roman": the same title romanized in Latin letters,',
        `  "lyrics": the FULL lyrics in native ${language} script, with \\n line breaks and [Verse 1]/[Chorus] section labels,`,
        '  "lyrics_roman": the SAME lyrics transliterated into Latin letters, phonetically, keeping the same \\n line breaks and section labels,',
        '  "style_tags": comma-separated production tags for a music AI,',
        '  "mood": one or two words in English',
        '}',
      ].join('\n')
    : [
        'Respond with ONLY a JSON object with keys:',
        '{ "title": short catchy title (max 60 chars), "lyrics": full lyrics with \\n line breaks,',
        '  "style_tags": comma-separated production tags, "mood": one or two words }',
      ].join('\n');

  const res = await fetch(`${cfg.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiApiKey}` },
    body: JSON.stringify({
      model: cfg.openaiModel,
      temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            `You are a professional ${language} songwriter and music producer. You write ` +
            'original, singable lyrics that feel natural to native speakers and produce ' +
            'clean JSON. Never include copyrighted lyrics or reference real artists/songs.',
        },
        {
          role: 'user',
          content: [
            `Write an original ${genre} song sung in ${language} about "${theme}".`,
            topic ? `The song MUST clearly belong to the theme/category: "${topic}".` : '',
            nonLatin
              ? `Write natural, idiomatic ${language} as a native speaker would sing it — ` +
                'not a word-for-word translation of English. Use everyday vocabulary.'
              : '',
            'Structure it with sections like [Verse 1], [Chorus], [Verse 2], [Bridge], [Outro].',
            'Keep it under ~2:30 of singing.',
            `The style_tags MUST include "${language}" and the genre so the music model sings in the right language.`,
            '',
            jsonSpec,
          ].filter(Boolean).join('\n'),
        },
      ],
    }),
  });

  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`OpenAI lyrics failed (${res.status}): ${b.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned no lyrics content');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
  }

  const lyrics = String(parsed.lyrics || '').trim();
  if (!lyrics) throw new Error('OpenAI returned empty lyrics');
  const lyricsRoman = String(parsed.lyrics_roman || '').trim();

  let style = String(parsed.style_tags || genre);
  if (!style.toLowerCase().includes(String(language).toLowerCase())) {
    style = `${language}, ${style}`; // make the vocal language explicit for Suno
  }

  return {
    title: String(parsed.title || `Untitled (${theme})`).slice(0, 100),
    titleRoman: String(parsed.title_roman || '').slice(0, 100),
    lyrics,                    // native script - used for description/display
    lyricsRoman,               // Latin transliteration - used for singing
    style_tags: style,
    mood: String(parsed.mood || 'reflective'),
    language,
  };
}

