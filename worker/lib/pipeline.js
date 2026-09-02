// worker/lib/pipeline.js
// Runs the whole song pipeline for one job, writing fine-grained progress to
// Redis after every stage so the dashboard shows a live status.
//
//   lyrics -> song -> thumbnail -> video -> Drive -> YouTube -> retention

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { updateJob, getConfig } = require('./store');
const { generateLyrics, generateSong, generateThumbnail } = require('./steps');
const { renderVideo, renderVideoFromClips, makeFallbackImage, sanitize } = require('./video');
const { storeSong, enforceRetention } = require('./drive');
const clips = require('./clips');
const { uploadToYoutube, addToPlaylist } = require('./youtube');

// Overall progress weighting per step (sums to 100).
const WEIGHT = { lyrics: 10, song: 45, thumbnail: 10, video: 20, upload: 15 };
const START = { lyrics: 0, song: 10, thumbnail: 55, video: 65, upload: 85 };

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * @param {string} jobId
 */
async function runJob(jobId) {
  const cfg = await getConfig();
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), `song-${jobId}-`));
  const audioFile = path.join(work, 'audio.mp3');
  const imageFile = path.join(work, 'image.png');
  const titleFile = path.join(work, 'title.txt');
  const outFile = path.join(work, 'out.mp4');

  const setStep = (step, status, extra = {}) =>
    updateJob(jobId, { step, status: 'running', steps: { [step]: status }, ...extra });

  const progress = (step, pct, note) =>
    updateJob(jobId, {
      progress: Math.min(99, Math.round(START[step] + (WEIGHT[step] * pct) / 100)),
      note,
    });

  const fail = async (step, err) => {
    const message = err && err.message ? err.message : String(err);
    console.error(`[job ${jobId}] ${step} failed:`, message);
    await updateJob(jobId, {
      status: 'error',
      step,
      steps: { [step]: 'error' },
      error: `${step}: ${message}`,
      note: `Failed at ${step}`,
    });
    return null;
  };

  try {
    await updateJob(jobId, { status: 'running', note: 'Starting…', progress: 1, startedAt: new Date().toISOString() });

    // 1) LYRICS ------------------------------------------------------------
    await setStep('lyrics', 'running');
    await progress('lyrics', 10, 'Writing lyrics with OpenAI…');
    let song;
    try {
      song = await generateLyrics(cfg);
    } catch (e) { return fail('lyrics', e); }
    await updateJob(jobId, {
      steps: { lyrics: 'done' },
      title: song.title, lyrics: song.lyrics, styleTags: song.style_tags, mood: song.mood,
      titleRoman: song.titleRoman || null, language: song.language || null,
    });
    await progress('lyrics', 100, `Lyrics ready: “${song.title}”`);

    // 2) SONG --------------------------------------------------------------
    await setStep('song', 'running');
    await progress('song', 5, 'Sending to Suno…');
    let audio;
    try {
      // A music model pronounces Indic languages far better from a Latin
      // transliteration, so prefer lyricsRoman when the model produced one.
      const sungLyrics = song.lyricsRoman && song.lyricsRoman.length > 40
        ? song.lyricsRoman
        : song.lyrics;
      const sungTitle = song.titleRoman || song.title;
      audio = await generateSong(
        cfg,
        { title: sungTitle, lyrics: sungLyrics, style_tags: song.style_tags },
        (msg) => progress('song', 50, msg)
      );
    } catch (e) { return fail('song', e); }
    await progress('song', 90, 'Downloading audio…');
    try {
      await download(audio.audioUrl, audioFile);
    } catch (e) { return fail('song', e); }
    await updateJob(jobId, { steps: { song: 'done' }, audioUrl: audio.audioUrl });
    await progress('song', 100, 'Song ready');

    // 3) THUMBNAIL ---------------------------------------------------------
    await setStep('thumbnail', 'running');
    await progress('thumbnail', 20, 'Generating cover art with Gemini…');
    try {
      const img = await generateThumbnail(cfg, {
        title: song.title, mood: song.mood, styleTags: song.style_tags,
      });
      await fsp.writeFile(imageFile, img);
    } catch (e) {
      // Non-fatal: fall back to a gradient so the video still renders.
      console.warn(`[job ${jobId}] thumbnail failed, using fallback: ${e.message}`);
      await makeFallbackImage(imageFile);
    }
    await updateJob(jobId, { steps: { thumbnail: 'done' }, hasThumbnail: true });
    await progress('thumbnail', 100, 'Cover art ready');

    // 4) VIDEO -------------------------------------------------------------
    // Prefer real clips the user dropped in the clips/ folder (made in Flow AI
    // or anywhere else). When there are none — or the mode says otherwise —
    // fall back to the generated cover image so the channel never stalls.
    await setStep('video', 'running');
    const mode = cfg.videoMode || 'auto';
    let picked = [];
    if (mode === 'auto' || mode === 'clips') {
      clips.ensureDirs();
      picked = clips.takeClips(cfg.clipsPerSong || 3);
    }

    let usedClips = 0;
    try {
      if (picked.length) {
        await progress('video', 10, `Building video from ${picked.length} clip(s)…`);
        const r = await renderVideoFromClips({
          clipPaths: picked.map((c) => c.path),
          audioFile, titleFile, outFile,
          title: song.title, titleRoman: song.titleRoman,
          workDir: work,
        });
        usedClips = r.clipsUsed;
        await clips.markUsed(picked); // never reuse the same clip
      } else {
        if (mode === 'clips') {
          // Explicitly asked for clips but the folder is empty - say so, then
          // still publish with the cover image rather than failing the run.
          console.warn(`[job ${jobId}] no clips available, using the cover image instead`);
        }
        await progress('video', 10, 'Rendering video from the cover image…');
        await renderVideo({
          audioFile, imageFile, titleFile, outFile,
          title: song.title, titleRoman: song.titleRoman,
        });
      }
    } catch (e) { return fail('video', e); }

    await updateJob(jobId, {
      steps: { video: 'done' },
      videoSource: usedClips ? 'clips' : 'thumbnail',
      clipsUsed: usedClips,
      clipsRemaining: clips.countClips(),
    });
    await progress('video', 100, usedClips ? `Video built from ${usedClips} clip(s)` : 'Video rendered');

    // 5) DRIVE + YOUTUBE ---------------------------------------------------
    await setStep('upload', 'running');
    await progress('upload', 10, 'Saving to Google Drive…');
    let drive = null;
    try {
      drive = await storeSong(cfg, {
        jobId, title: song.title, videoPath: outFile, audioPath: audioFile, imagePath: imageFile,
      });
      await updateJob(jobId, {
        driveFolderId: drive.folderId,
        driveVideoId: drive.videoFileId,
        driveFiles: drive.files.map((f) => ({ id: f.id, name: f.name, link: f.webViewLink })),
      });
    } catch (e) {
      // Drive is storage, not the deliverable - warn but keep going.
      console.warn(`[job ${jobId}] Drive upload failed: ${e.message}`);
      await updateJob(jobId, { driveError: e.message });
    }

    await progress('upload', 45, 'Uploading to YouTube…');
    let yt;
    try {
      yt = await uploadToYoutube(cfg, {
        videoPath: outFile, imagePath: imageFile,
        title: song.title, titleRoman: song.titleRoman, language: song.language,
        lyrics: song.lyrics, mood: song.mood, styleTags: song.style_tags,
      });
    } catch (e) { return fail('upload', e); }

    // Add to the configured playlist (non-fatal if it fails).
    await progress('upload', 90, 'Adding to playlist…');
    const pl = await addToPlaylist(cfg, yt.youtubeId);

    await updateJob(jobId, {
      status: 'done', step: 'upload', steps: { upload: 'done' },
      youtubeId: yt.youtubeId, youtubeUrl: yt.youtubeUrl,
      playlistAdded: pl.added, playlistError: pl.added ? null : pl.reason || null,
      progress: 100,
      note: pl.added ? 'Published & added to playlist 🎉' : 'Published 🎉',
      error: null,
      finishedAt: new Date().toISOString(),
    });

    // 6) RETENTION ---------------------------------------------------------
    try {
      const keep = cfg.driveKeepSongs || 4;
      const r = await enforceRetention(cfg, keep);
      if (r.deletedFiles) {
        console.log(`[job ${jobId}] retention: removed ${r.deletedSongs} old song(s), ${r.deletedFiles} file(s)`);
      }
    } catch (e) {
      console.warn(`[job ${jobId}] retention failed: ${e.message}`);
    }

    console.log(`[job ${jobId}] complete -> ${yt.youtubeUrl}`);
    return yt;
  } catch (e) {
    return fail('unknown', e);
  } finally {
    fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runJob };
