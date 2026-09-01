// lib/thumbnail.js
// generateThumbnail() - calls the Gemini image generation model and returns
// a base64 PNG (no data: prefix). Used as the YouTube thumbnail and as the
// still/background image handed to the video worker.
//
// Uses the Google Generative Language REST API. The image-capable model is
// configurable via GEMINI_IMAGE_MODEL. If your key/region doesn't have the
// preview image model, swap in an Imagen model id.

import { getConfig } from './config.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * @param {object} args
 * @param {string} args.title
 * @param {string} [args.mood]
 * @param {string} [args.styleTags]
 * @returns {Promise<{base64:string, mimeType:string}>}
 */
export async function generateThumbnail({ title, mood = '', styleTags = '' }) {
  const cfg = await getConfig();
  const GEMINI_API_KEY = cfg.geminiApiKey;
  const IMAGE_MODEL = cfg.geminiImageModel || 'gemini-2.0-flash-preview-image-generation';
  if (!GEMINI_API_KEY) throw new Error('Gemini API key is not set (Settings > Thumbnail)');

  const prompt = [
    `Design a striking, high-contrast YouTube thumbnail / album cover for a song titled "${title}".`,
    mood ? `Mood: ${mood}.` : '',
    styleTags ? `Musical style: ${styleTags}.` : '',
    'Cinematic lighting, bold focal subject, vibrant but tasteful colors, room for a title overlay.',
    '16:9 aspect ratio. No text, no watermark, no logos.',
  ]
    .filter(Boolean)
    .join(' ');

  const url = `${API_ROOT}/models/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // Preview image model requires asking for the IMAGE modality.
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini thumbnail request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const inline = imgPart?.inlineData || imgPart?.inline_data;

  if (!inline?.data) {
    throw new Error(
      `Gemini returned no image data. The model "${IMAGE_MODEL}" may not support image output ` +
        'for your key/region - try setting GEMINI_IMAGE_MODEL to an Imagen model. ' +
        `Response: ${JSON.stringify(data).slice(0, 400)}`
    );
  }

  return {
    base64: inline.data,
    mimeType: inline.mimeType || inline.mime_type || 'image/png',
  };
}
