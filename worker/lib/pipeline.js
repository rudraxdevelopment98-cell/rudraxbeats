// worker/lib/pipeline.js
// Runs the whole song pipeline for one job, writing fine-grained progress to
// Redis after every stage so the dashboard shows a live status.
//
//   lyrics -> song -> thumbnail -> video -> Drive -> YouTube -> retention

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { updateJob, getConfig, setAlert } = require('./store');
const { generateLyrics, generateSong, generateThumbnail } = require('./steps');
const { renderVideo, renderVideoFromClips, renderVideoFromScenes, makeFallbackImage, sanitize } = require('./video');
const { generateSceneImages } = require('./scenes');
const { storeSong, enforceRetention } = require('./drive');
const { saveLocally } = require('./localsave');
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

  // Progress writes are cosmetic: some callers fire them without awaiting (the
  // Suno and scene-painting callbacks), so a Redis hiccup here must never turn
  // into an unhandled rejection that kills an unattended worker.
  const progress = (step, pct, note) =>
    updateJob(jobId, {
      progress: Math.min(99, Math.round(START[step] + (WEIGHT[step] * pct) / 100)),
      note,
    }).catch((e) => console.warn(`[job ${jobId}] progress write failed: ${e.message}`));

  const fail = async (step, err) => {
    const message = err && err.message ? err.message : String(err);
    console.error(`[job ${jobId}] ${step} failed:`, message);
    // The one failure a retry can never fix: the Suno cookie has expired.
    if (step === 'song' && /cookie|captcha|401|403/i.test(message)) {
      await setAlert(
        'Suno rejected the request — the SUNO_COOKIE in your suno-api deployment has ' +
        'probably expired. Paste a fresh cookie there and the next run will work.'
      ).catch(() => {});
    }
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
    // Hands-free by design. Three sources, tried in this order:
    //   clips   - real clips dropped in the clips/ folder (Flow AI etc.)
    //   scenes  - AI-painted shots, Ken-Burns + cross-fade (needs no human)
    //   cover   - the single cover image with a waveform (always works)
    // `videoMode` picks the starting point; every mode falls through to the
    // cover image rather than failing the run.
    await setStep('video', 'running');
    const mode = cfg.videoMode || 'auto';
    let picked = [];
    if (mode === 'auto' || mode === 'clips') {
      clips.ensureDirs();
      picked = clips.takeClips(cfg.clipsPerSong || 3);
    }

    let usedClips = 0;
    let usedScenes = 0;
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
        // No clips (or the mode never wanted them): paint the scenes ourselves.
        const wantScenes = (mode === 'auto' || mode === 'scenes' || mode === 'clips') && Boolean(cfg.geminiApiKey);
        let scenePaths = [];
        if (wantScenes) {
          await progress('video', 10, 'Directing the music video…');
          try {
            const r = await generateSceneImages(
              cfg,
              {
                title: song.title, titleRoman: song.titleRoman, mood: song.mood,
                styleTags: song.style_tags, topic: cfg.playlistTopic, language: song.language,
              },
              { count: cfg.sceneCount || 4, workDir: work, onProgress: (m) => progress('video', 30, m) }
            );
            scenePaths = r.paths;
          } catch (e) {
            console.warn(`[job ${jobId}] scene images failed: ${e.message}`);
          }
        }

        if (scenePaths.length >= 2) {
          await progress('video', 60, `Animating ${scenePaths.length} scenes…`);
          const r = await renderVideoFromScenes({
            imagePaths: scenePaths,
            audioFile, titleFile, outFile,
            title: song.title, titleRoman: song.titleRoman,
            workDir: work, sceneSeconds: cfg.sceneSeconds || 8,
          });
          usedScenes = r.scenesUsed;
        } else {
          if (mode === 'clips') {
            console.warn(`[job ${jobId}] no clips available, using the cover image instead`);
          }
          await progress('video', 60, 'Rendering video from the cover image…');
          await renderVideo({
            audioFile, imageFile, titleFile, outFile,
            title: song.title, titleRoman: song.titleRoman,
          });
        }
      }
    } catch (e) { return fail('video', e); }

    const videoSource = usedClips ? 'clips' : usedScenes ? 'scenes' : 'thumbnail';
    await updateJob(jobId, {
      steps: { video: 'done' },
      videoSource,
      clipsUsed: usedClips,
      scenesUsed: usedScenes,
      clipsRemaining: clips.countClips(),
    });
    await progress(
      'video', 100,
      usedClips ? `Video built from ${usedClips} clip(s)`
        : usedScenes ? `Video built from ${usedScenes} AI scenes`
          : 'Video rendered'
    );

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

    // Copy the finished song into the folder chosen in Settings. The worker
    // runs on that PC, so no sync script or manual download is involved.
    let local = { saved: false, dir: null, files: [] };
    try {
      local = await saveLocally(cfg, {
        title: song.title, videoPath: outFile, audioPath: audioFile, imagePath: imageFile,
        lyrics: song.lyrics, youtubeUrl: yt.youtubeUrl,
      });
      if (local.saved) console.log(`[job ${jobId}] saved locally -> ${local.dir}`);
    } catch (e) {
      console.warn(`[job ${jobId}] local save failed: ${e.message}`);
      local = { saved: false, dir: null, files: [], reason: e.message };
    }

    // A full run means nothing is waiting on a human any more.
    await setAlert(null).catch(() => {});

    await updateJob(jobId, {
      status: 'done', step: 'upload', steps: { upload: 'done' },
      localDir: local.saved ? local.dir : null,
      localSaved: local.saved ? local.files.length : 0,
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
