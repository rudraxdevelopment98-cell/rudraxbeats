// worker/scripts/offline-demo.js
//   npm run demo        (from the worker folder)
//
// Runs the real pipeline code — the same generateLyrics, generateThumbnail and
// renderPosterVideo the nightly job uses — with the three paid services
// replaced by local stand-ins:
//
//   Gemini text   -> a local stub that returns a Gujarati song as JSON
//   Gemini image  -> a locally generated cover image
//   Suno          -> a short melody rendered with ffmpeg
//
// The point is to prove the chain end to end (lyrics -> cover -> poster video)
// on any machine, with no keys, no Redis and no internet. What comes out is a
// real mp4 you can play.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { ffmpegPath, renderPosterVideo, probeDuration, HAS_DRAWTEXT } = require('../lib/video');

const SONG = {
  title: 'ઢોલ વાગે રે',
  title_roman: 'Dhol Vaage Re',
  lyrics: [
    '[Verse 1]', 'સાંજ ઢળે ને ગામમાં દીવા થાય', 'ઢોલનો નાદ સૌને ખેંચી લાવે',
    '', '[Chorus]', 'ઢોલ વાગે રે, પગ થિરકે રે', 'નવરાત્રિની રાત જામે રે',
    '', '[Verse 2]', 'ગોળ ફરે છે રંગનું વર્તુળ', 'હાથમાં તાળી, હૈયામાં હરખ',
    '', '[Outro]', 'ઢોલ વાગે રે…',
  ].join('\n'),
  lyrics_roman: [
    '[Verse 1]', 'Saanj dhale ne gaam ma diva thay', 'Dholno naad sauney khenchi laave',
    '', '[Chorus]', 'Dhol vaage re, pag thirke re', 'Navratri ni raat jaame re',
    '', '[Verse 2]', 'Gol phare chhe rang nu vartul', 'Hath ma taali, haiya ma harakh',
    '', '[Outro]', 'Dhol vaage re…',
  ].join('\n'),
  style_tags: 'traditional garba with dhol and tabla, festive',
  mood: 'festive',
};

const run = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-400)))));
  });

/** Stand-ins for Gemini text and Gemini image, on one local port. */
async function startStubs(coverPng) {
  const cover = fs.readFileSync(coverPng).toString('base64');
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const wantsImage = /IMAGE/.test(body) && /responseModalities/.test(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: wantsImage
                  ? [{ inlineData: { data: cover, mimeType: 'image/png' } }]
                  : [{ text: JSON.stringify(SONG) }],
              },
            },
          ],
          usageMetadata: { totalTokenCount: 512 },
        })
      );
    });
  });
  await new Promise((r) => srv.listen(0, r));
  process.env.GEMINI_API_ROOT = `http://127.0.0.1:${srv.address().port}/v1beta`;
  return srv;
}

(async function main() {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'song-demo-'));
  const audioFile = path.join(work, 'song.mp3');
  const imageFile = path.join(work, 'cover.png');
  const outFile = process.argv[2] || path.join(work, 'demo.mp4');

  console.log('\n  AI Song Engine — offline run (no keys, no internet)');
  console.log('  ───────────────────────────────────────────────────');
  console.log(`  ffmpeg        : ${ffmpegPath}`);
  console.log(`  title overlay : ${HAS_DRAWTEXT ? 'yes' : 'no (this ffmpeg has no drawtext)'}`);

  // a stand-in cover: the kind of image Gemini returns
  await run([
    '-y', '-f', 'lavfi', '-i',
    'gradients=s=1920x1080:c0=0x3b0764:c1=0xf59e0b:x0=200:y0=200:duration=1',
    '-frames:v', '1', imageFile,
  ]);

  // a stand-in song: 45s of a simple tune, in place of Suno
  await run([
    '-y', '-f', 'lavfi', '-i',
    'sine=frequency=294:duration=45,volume=0.2', '-c:a', 'libmp3lame', audioFile,
  ]);

  const srv = await startStubs(imageFile);
  try {
    const cfg = {
      geminiApiKey: 'demo', lyricsProvider: 'gemini',
      songLanguage: 'Gujarati', playlistTopic: 'Navratri garba',
      songGenre: 'traditional garba with dhol', songVocal: 'female', songMood: 'energetic',
    };

    const { generateLyrics, generateThumbnail } = require('../lib/steps');

    console.log('\n  1. lyrics');
    const song = await generateLyrics(cfg);
    console.log(`     title       : ${song.title}  (${song.titleRoman})`);
    console.log(`     style tags  : ${song.style_tags}`);
    console.log(`     sung lyrics : ${song.lyricsRoman.split('\n')[1]} …`);

    console.log('\n  2. cover art');
    const img = await generateThumbnail(cfg, { title: song.title, mood: song.mood, styleTags: song.style_tags });
    await fsp.writeFile(imageFile, img);
    console.log(`     ${(img.length / 1024).toFixed(0)} KB written`);

    console.log('\n  3. video (poster mode: the cover held over the song)');
    const t0 = Date.now();
    await renderPosterVideo({
      audioFile, imageFile, titleFile: path.join(work, 'title.txt'), outFile,
      title: song.title, titleRoman: song.titleRoman,
    });
    const secs = await probeDuration(outFile);
    console.log(`     ${outFile}`);
    console.log(`     ${(fs.statSync(outFile).size / 1e6).toFixed(2)} MB · ${secs}s · rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    console.log('\n  Ready to upload. In a real run this file goes to YouTube with the');
    console.log('  cover as its thumbnail, the lyrics in the description, and into your playlist.\n');
  } finally {
    srv.close();
  }
})().catch((e) => {
  console.error('\n  FAILED:', e.message, '\n');
  process.exit(1);
});
