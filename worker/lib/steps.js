// worker/lib/steps.js
// Lyrics (OpenAI), song (Suno wrapper), thumbnail (Gemini).
// Mirrors web/lib/{lyrics,song,thumbnail}.js but runs in the always-on worker
// where multi-minute polling is fine.

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
// Angles keep every song on the playlist's subject while staying distinct,
// so the channel doesn't look like mass-produced near-duplicates.
const ANGLES = [
  'a personal memory', 'a hopeful promise', 'a bittersweet goodbye',
  'a celebration', 'a quiet reflection', 'an energetic anthem',
  'a letter to someone', 'a sunrise beginning', 'a late-night confession',
  'a story told over one day', 'gratitude', 'overcoming a setback',
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- lyrics ---
async function generateLyrics(cfg) {
  if (!cfg.openaiApiKey) throw new Error('OpenAI API key is not set (Settings → Lyrics)');
  const genre = pick(GENRES);
  const language = cfg.songLanguage || 'English';

  // If a playlist subject/category is configured, every song is written about
  // that subject (with an angle picked per run so tracks aren't near-duplicates).
  // Otherwise fall back to a random general theme.
  const topic = String(cfg.playlistTopic || '').trim();
  const theme = topic
    ? `${topic} — a fresh angle: ${pick(ANGLES)}`
    : pick(THEMES);

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
            'You are a professional songwriter and music producer. You write original, ' +
            'radio-friendly song lyrics and produce clean JSON. Never include copyrighted ' +
            'lyrics or reference real artists/songs.',
        },
        {
          role: 'user',
          content: [
            `Write an original ${genre} song in ${language} about "${theme}".`,
            topic ? `The song MUST clearly belong to the theme/category: "${topic}".` : '',
            'Structure it with sections like [Verse 1], [Chorus], [Verse 2], [Bridge], [Outro].',
            'Keep it under ~2:30 of singing.',
            '',
            'Respond with ONLY a JSON object with keys:',
            '{ "title": short catchy title (max 60 chars), "lyrics": full lyrics with \\n line breaks,',
            '  "style_tags": comma-separated production tags, "mood": one or two words }',
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
  return {
    title: String(parsed.title || `Untitled (${theme})`).slice(0, 100),
    lyrics,
    style_tags: String(parsed.style_tags || genre),
    mood: String(parsed.mood || 'reflective'),
  };
}

// ------------------------------------------------------------------ song ---
async function generateSong(cfg, { title, lyrics, style_tags }, onProgress = () => {}) {
  const base = (cfg.sunoBaseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Suno wrapper URL is not set (Settings → Song)');

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.sunoApiKey) headers.Authorization = `Bearer ${cfg.sunoApiKey}`;

  const POLL_MS = 6000;
  const MAX_POLLS = 100; // ~10 min - fine here, no serverless limit

  if ((cfg.sunoMode || 'suno-api') === 'suno-api') {
    // gcui-art/suno-api
    const sub = await fetch(`${base}/api/custom_generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: lyrics,
        tags: style_tags,
        title,
        make_instrumental: false,
        wait_audio: false,
      }),
    });
    if (!sub.ok) {
      const b = await sub.text().catch(() => '');
      throw new Error(
        `suno-api /api/custom_generate failed (${sub.status}). Is SUNO_COOKIE valid? ${b.slice(0, 300)}`
      );
    }
    const clips = await sub.json();
    const ids = (Array.isArray(clips) ? clips : []).map((c) => c && c.id).filter(Boolean);
    if (!ids.length) throw new Error(`suno-api returned no clip ids: ${JSON.stringify(clips).slice(0, 300)}`);

    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_MS);
      const r = await fetch(`${base}/api/get?ids=${encodeURIComponent(ids.join(','))}`, { headers });
      if (!r.ok) { onProgress(`waiting… (${r.status})`); continue; }
      const list = await r.json();
      const arr = Array.isArray(list) ? list : [];
      const ready = arr.find(
        (c) => c && typeof c.audio_url === 'string' && /^https?:\/\//.test(c.audio_url) &&
          ['streaming', 'complete'].includes(String(c.status || '').toLowerCase())
      );
      onProgress(`Suno: ${arr.map((c) => c.status).join(' / ') || 'working'} (${i + 1})`);
      if (ready) return { audioUrl: ready.audio_url, imageUrl: ready.image_url || null };
      if (arr.length && arr.every((c) => String(c.status || '').toLowerCase() === 'error')) {
        throw new Error('suno-api returned error for all clips (cookie expired or captcha?)');
      }
    }
    throw new Error('suno-api timed out waiting for audio');
  }

  // generic paid wrapper: submit -> poll
  if (!cfg.sunoApiKey) throw new Error('Suno provider API key is not set');
  const sub = await fetch(`${base}${cfg.sunoSubmitPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      custom_mode: true, make_instrumental: false,
      prompt: lyrics, lyrics, title, tags: style_tags, style: style_tags, wait_audio: false,
    }),
  });
  if (!sub.ok) throw new Error(`Suno submit failed (${sub.status})`);
  const j = await sub.json();
  const findAudio = (o) => {
    const stack = [o]; const seen = new Set();
    while (stack.length) {
      const c = stack.pop();
      if (!c || typeof c !== 'object' || seen.has(c)) continue;
      seen.add(c);
      for (const v of Object.values(c)) {
        if (typeof v === 'string' && /^https?:\/\/.+\.(mp3|wav|m4a|ogg)/i.test(v)) return v;
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return null;
  };
  let audio = findAudio(j);
  if (audio) return { audioUrl: audio, imageUrl: null };
  const id = j?.id || j?.job_id || j?.task_id || j?.data?.id || j?.data?.[0]?.id;
  if (!id) throw new Error('Suno submit returned no audio URL or job id');
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    const r = await fetch(`${base}${cfg.sunoStatusPath}?id=${encodeURIComponent(id)}`, { headers });
    if (!r.ok) continue;
    const s = await r.json();
    audio = findAudio(s);
    onProgress(`Suno: polling (${i + 1})`);
    if (audio) return { audioUrl: audio, imageUrl: null };
  }
  throw new Error('Suno generation timed out');
}

// ------------------------------------------------------------- thumbnail ---
async function generateThumbnail(cfg, { title, mood, styleTags }) {
  if (!cfg.geminiApiKey) throw new Error('Gemini API key is not set (Settings → Thumbnail)');
  const prompt = [
    `Design a striking, high-contrast YouTube thumbnail / album cover for a song titled "${title}".`,
    mood ? `Mood: ${mood}.` : '',
    styleTags ? `Musical style: ${styleTags}.` : '',
    'Cinematic lighting, bold focal subject, vibrant but tasteful colors.',
    '16:9 aspect ratio. No text, no watermark, no logos.',
  ].filter(Boolean).join(' ');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiImageModel}:generateContent?key=${cfg.geminiApiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`Gemini thumbnail failed (${res.status}): ${b.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const p = parts.find((x) => x.inlineData?.data || x.inline_data?.data);
  const inline = p?.inlineData || p?.inline_data;
  if (!inline?.data) {
    throw new Error(`Gemini returned no image (model "${cfg.geminiImageModel}" may not support images)`);
  }
  return Buffer.from(inline.data, 'base64');
}

module.exports = { generateLyrics, generateSong, generateThumbnail };
