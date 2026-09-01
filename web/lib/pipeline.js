// lib/pipeline.js
// runPipeline() - orchestrates the full daily-song pipeline, writing status
// to KV after every step so the dashboard can show live progress.
//
//   lyrics (OpenAI) -> song (Suno wrapper) -> thumbnail (Gemini)
//     -> video (worker /render) -> upload (YouTube Data API)
//
// Each step is wrapped so a failure marks that step (and the job) as errored,
// records the message, and stops the pipeline. Steps are resilient in the
// sense that partial artifacts (lyrics, audioUrl, etc.) are persisted as soon
// as they exist, so a failed run still shows what was produced.

import { createJob, updateJob, setStep, getJob } from './db.js';
import { generateLyrics } from './lyrics.js';
import { generateSong } from './song.js';
import { generateThumbnail } from './thumbnail.js';
import { renderVideo } from './worker.js';
import { uploadToYoutube } from './youtube.js';

/**
 * Run the whole pipeline. If jobId is provided it resumes/updates that job,
 * otherwise a new job is created.
 *
 * @param {object} [opts]
 * @param {string} [opts.jobId]     existing job id to attach to
 * @param {string} [opts.trigger]   'manual' | 'cron'
 * @param {object} [opts.lyricsOpts] passthrough to generateLyrics
 * @returns {Promise<object>} the final job record
 */
export async function runPipeline(opts = {}) {
  const trigger = opts.trigger || 'manual';
  let job = opts.jobId ? await getJob(opts.jobId) : await createJob({ trigger });
  if (!job) job = await createJob({ trigger });
  const id = job.id;

  const fail = async (step, err) => {
    const message = err?.message || String(err);
    console.error(`[pipeline ${id}] step "${step}" failed:`, message);
    await updateJob(id, {
      status: 'error',
      step,
      steps: { [step]: 'error' },
      error: `${step}: ${message}`,
    });
    return getJob(id);
  };

  try {
    await updateJob(id, { status: 'running' });

    // 1) LYRICS -------------------------------------------------------------
    await setStep(id, 'lyrics', 'running');
    let lyricsData;
    try {
      lyricsData = await generateLyrics(opts.lyricsOpts || {});
    } catch (e) {
      return fail('lyrics', e);
    }
    await updateJob(id, {
      steps: { lyrics: 'done' },
      title: lyricsData.title,
      lyrics: lyricsData.lyrics,
      styleTags: lyricsData.style_tags,
      mood: lyricsData.mood,
    });

    // 2) SONG ---------------------------------------------------------------
    await setStep(id, 'song', 'running');
    let songData;
    try {
      songData = await generateSong(
        {
          title: lyricsData.title,
          lyrics: lyricsData.lyrics,
          style_tags: lyricsData.style_tags,
        },
        (msg) => console.log(`[pipeline ${id}] song: ${msg}`)
      );
    } catch (e) {
      return fail('song', e);
    }
    await updateJob(id, {
      steps: { song: 'done' },
      audioUrl: songData.audioUrl,
    });

    // 3) THUMBNAIL ----------------------------------------------------------
    await setStep(id, 'thumbnail', 'running');
    let thumb;
    try {
      thumb = await generateThumbnail({
        title: lyricsData.title,
        mood: lyricsData.mood,
        styleTags: lyricsData.style_tags,
      });
    } catch (e) {
      return fail('thumbnail', e);
    }
    // Don't store the full base64 in KV (size limits) - just note success.
    await updateJob(id, { steps: { thumbnail: 'done' }, hasThumbnail: true });

    // 4) VIDEO --------------------------------------------------------------
    await setStep(id, 'video', 'running');
    let videoData;
    try {
      videoData = await renderVideo({
        audioUrl: songData.audioUrl,
        title: lyricsData.title,
        thumbnailBase64: thumb.base64,
      });
    } catch (e) {
      return fail('video', e);
    }
    await updateJob(id, {
      steps: { video: 'done' },
      videoUrl: videoData.videoUrl,
    });

    // 5) UPLOAD -------------------------------------------------------------
    await setStep(id, 'upload', 'running');
    let uploadData;
    try {
      uploadData = await uploadToYoutube({
        videoUrl: videoData.videoUrl,
        title: lyricsData.title,
        lyrics: lyricsData.lyrics,
        mood: lyricsData.mood,
        styleTags: lyricsData.style_tags,
        thumbnailBase64: thumb.base64,
      });
    } catch (e) {
      return fail('upload', e);
    }

    await updateJob(id, {
      status: 'done',
      step: 'upload',
      steps: { upload: 'done' },
      youtubeId: uploadData.youtubeId,
      youtubeUrl: uploadData.youtubeUrl,
      error: null,
    });

    console.log(`[pipeline ${id}] complete -> ${uploadData.youtubeUrl}`);
    return getJob(id);
  } catch (e) {
    // Catch-all for anything not caught by the per-step handlers.
    return fail(job.step || 'unknown', e);
  }
}
