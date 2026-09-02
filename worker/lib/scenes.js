// worker/lib/scenes.js
// Hands-free music-video visuals: instead of waiting for clips made by hand in
// Flow AI, the engine writes its own shot list and paints each shot with the
// same Gemini key already used for the cover art. video.js then gives every
// image a Ken-Burns move and cross-fades them into a montage.
//
// Everything here degrades instead of throwing: fewer images than asked for is
// fine, and zero images just means the pipeline falls back to the cover image.

const fsp = require('fs/promises');
const path = require('path');

const { geminiImage } = require('./steps');

// House style so the shots of one song look like they belong together.
const LOOK =
  'cinematic still, photoreal, 16:9, rich colour grading, soft volumetric light, ' +
  'shallow depth of field, no text, no watermark, no logos, no captions';

/**
 * Ask OpenAI for a short shot list that matches the song. English prompts on
 * purpose - image models follow them far more reliably than Gujarati ones.
 * @returns {Promise<string[]>} one visual description per scene
 */
async function planScenes(cfg, { title, titleRoman, mood, styleTags, topic, language, count }) {
  const fallback = () => {
    const subject = topic || `a ${language || ''} song titled "${titleRoman || title}"`.trim();
    const beats = [
      'wide establishing shot at golden hour',
      'close, intimate detail shot',
      'movement and celebration, evening light',
      'quiet reflective moment, blue hour',
      'hopeful wide shot at sunrise',
      'atmospheric night shot with warm practical lights',
    ];
    return beats.slice(0, count).map((b) => `${subject} - ${b}. ${LOOK}`);
  };

  if (!cfg.openaiApiKey) return fallback();

  try {
    const res = await fetch(`${cfg.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiApiKey}` },
      body: JSON.stringify({
        model: cfg.openaiModel,
        temperature: 0.8,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a music-video director. You describe photographic shots for an ' +
              'image model: concrete subject, setting, time of day, camera framing. ' +
              'No text or lettering in the frame. Respond with clean JSON only.',
          },
          {
            role: 'user',
            content: [
              `Song title: "${title}"${titleRoman ? ` (${titleRoman})` : ''}.`,
              language ? `Sung in ${language}.` : '',
              topic ? `Channel/playlist subject: ${topic}.` : '',
              mood ? `Mood: ${mood}.` : '',
              styleTags ? `Musical style: ${styleTags}.` : '',
              '',
              `Write ${count} different shots that together tell this song's story.`,
              'Each shot must stand on its own as a single image, share the same visual',
              'style, and contain no readable text.',
              '',
              `Respond with ONLY: { "scenes": [ ${count} strings in English ] }`,
            ].filter(Boolean).join('\n'),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI shot list failed (${res.status})`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
    const list = (Array.isArray(parsed.scenes) ? parsed.scenes : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .slice(0, count);
    if (list.length < 2) return fallback();
    return list.map((s) => `${s} ${LOOK}`);
  } catch (e) {
    console.warn(`scene planning fell back to templates: ${e.message}`);
    return fallback();
  }
}

/**
 * Plan and paint the scene images for one song.
 *
 * @returns {Promise<{paths: string[], prompts: string[], failed: number}>}
 */
async function generateSceneImages(cfg, song, { count = 4, workDir, onProgress = () => {} } = {}) {
  const n = Math.max(1, Math.min(8, count));
  const prompts = await planScenes(cfg, { ...song, count: n });

  const paths = [];
  let failed = 0;
  for (let i = 0; i < prompts.length; i++) {
    onProgress(`Painting scene ${i + 1}/${prompts.length}…`);
    let img = null;
    for (let attempt = 0; attempt < 2 && !img; attempt++) {
      try {
        img = await geminiImage(cfg, prompts[i]);
      } catch (e) {
        if (attempt) console.warn(`scene ${i + 1} failed: ${e.message}`);
        else await new Promise((r) => setTimeout(r, 2000)); // brief rate-limit backoff
      }
    }
    if (!img) { failed++; continue; }
    const file = path.join(workDir, `scene-src-${i}.png`);
    await fsp.writeFile(file, img);
    paths.push(file);
  }
  return { paths, prompts, failed };
}

module.exports = { generateSceneImages, planScenes };
