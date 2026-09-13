// lib/pipelineSpec.js
// The pipeline described as nodes, so the dashboard can show the whole flow and
// let each stage be configured and tested on its own.
//
// Every node names: what it does, which config fields belong to it, which model
// list it can choose from, how to get the credential it needs, and which test
// proves that THIS stage does its real job (not just "the key is valid").
//
// Keep `fields` in sync with FIELDS in lib/config.js - the UI renders whatever
// is listed here and nothing else.

export const NODES = [
  {
    id: 'lyrics',
    icon: '✍️',
    title: 'Lyrics',
    provider: 'Gemini (free) or OpenAI',
    does: 'Writes the title, the lyrics (native script + romanized) and the style tags for every song — in your language, genre, voice and mood.',
    // This stage can run on two different providers, so its fields, model list
    // and instructions all depend on which one is selected.
    providerField: 'lyricsProvider',
    providerOptions: [
      {
        value: 'gemini',
        label: 'Google Gemini — free tier ★',
        blurb: 'Costs nothing and reuses the Gemini key the cover art already needs.',
        fields: ['geminiApiKey', 'geminiTextModel'],
        modelField: 'geminiTextModel',
        modelsTarget: 'gemini-text',
        howTo: {
          title: 'Get a Gemini API key (free)',
          link: 'https://aistudio.google.com/app/apikey',
          linkLabel: 'aistudio.google.com → API keys',
          steps: [
            'Open AI Studio with any Google account.',
            '“Create API key” → pick or create a Google Cloud project.',
            'Copy the key (starts with AIza) and paste it below. The same key can also do the cover art.',
            'Leave the model blank — the engine tries the current Gemini models and keeps the one that answers.',
          ],
          note: 'The free tier has a daily limit that resets by itself; one song a day is far below it.',
        },
      },
      {
        value: 'openai',
        label: 'OpenAI — paid (or any OpenAI-compatible provider)',
        blurb: 'Needs credit on the account. The same setting also drives Groq, OpenRouter and other OpenAI-compatible APIs — just change the base URL.',
        fields: ['openaiApiKey', 'openaiModel', 'openaiBaseUrl'],
        modelField: 'openaiModel',
        modelsTarget: 'openai',
        howTo: {
          title: 'Use OpenAI, Groq or OpenRouter',
          link: 'https://platform.openai.com/api-keys',
          linkLabel: 'platform.openai.com → API keys',
          steps: [
            'OpenAI: create a key at the link below, then add credit under Billing — a key with no credit returns “credit_balance_exhausted”.',
            'Groq (free tier): make a key at console.groq.com/keys, set the base URL to https://api.groq.com/openai/v1 and pick a llama model.',
            'OpenRouter: make a key at openrouter.ai/keys, set the base URL to https://openrouter.ai/api/v1 and choose a model whose id ends in :free.',
            'Press “Load models” after saving the key to see what that account can actually use.',
          ],
          note: 'Any provider that speaks the OpenAI chat API works here — only the key and the base URL change.',
        },
      },
    ],
    fields: ['geminiApiKey', 'geminiTextModel'],
    modelField: 'geminiTextModel',
    modelsTarget: 'gemini-text',
    test: 'lyrics',
    testDoes: 'Writes two real lines in your song language and shows them here.',
  },
  {
    id: 'song',
    icon: '🎵',
    title: 'Song',
    provider: 'Suno (your Pro account)',
    does: 'Turns the lyrics into the actual track. Runs through your own self-hosted suno-api, so your Suno Pro credits are what get used.',
    fields: ['sunoBaseUrl', 'sunoMode', 'sunoApiKey', 'sunoSubmitPath', 'sunoStatusPath', 'sunoModel'],
    test: 'song',
    testDoes: 'Asks your wrapper for the session limit — proves the cookie is alive and shows how many credits are left.',
    howTo: {
      title: 'Deploy your own suno-api',
      link: 'https://github.com/gcui-art/suno-api',
      linkLabel: 'github.com/gcui-art/suno-api',
      steps: [
        'Open the repo above and use its “Deploy with Vercel” button.',
        'In a browser signed in to suno.com, open DevTools (F12) → Application → Cookies → copy the whole cookie string for suno.com.',
        'In the new Vercel project → Settings → Environment Variables → add SUNO_COOKIE with that value → Redeploy.',
        'Paste that deployment URL below (for example https://my-suno-api.vercel.app) and leave Mode on suno-api.',
      ],
      note: 'Suno has no official API — this is why a cookie is involved, and why it expires every few weeks. The dashboard warns you before a run fails.',
    },
  },
  {
    id: 'cover',
    icon: '🖼️',
    title: 'Cover art',
    provider: 'Gemini',
    does: 'Paints the cover image used as the YouTube thumbnail, as the poster in poster mode, and as the scene images in the AI-scene video.',
    fields: ['geminiApiKey', 'geminiImageModel'],
    modelField: 'geminiImageModel',
    modelsTarget: 'gemini',
    test: 'cover',
    testDoes: 'Generates a real image and shows it here, so you can see the quality before a song uses it.',
    howTo: {
      title: 'Get a Gemini API key',
      link: 'https://aistudio.google.com/app/apikey',
      linkLabel: 'aistudio.google.com → API keys',
      steps: [
        'Open AI Studio with the Google account you want to bill.',
        '“Create API key” → pick or create a Google Cloud project.',
        'Copy the key (starts with AIza) and paste it below.',
        'Leave the model blank — the engine tries the current image models and keeps the one that answers.',
      ],
      note: 'The key must have an image-capable model. The test below says so explicitly instead of just “key works”.',
    },
  },
  {
    id: 'video',
    icon: '🎬',
    title: 'Video',
    provider: 'Worker + ffmpeg (your PC)',
    does: 'Builds the file YouTube actually accepts: the poster over the audio, an AI-scene montage, or your own clips.',
    fields: ['videoMode', 'lyricsOnVideo', 'sceneCount', 'sceneSeconds', 'clipsPerSong'],
    test: 'video',
    testDoes: 'Checks the worker is connected and reports its ffmpeg, fonts and how many clips are waiting.',
    howTo: {
      title: 'Connect the worker PC',
      link: '/settings',
      linkLabel: 'Settings → Worker app',
      steps: [
        'Download the worker app from the Settings page and run Install.bat.',
        'Paste REDIS_URL once when it asks (Settings has a Copy button for it).',
        'Leave the window open — that window is the engine. This node turns green when it checks in.',
      ],
      note: 'No API key here: the rendering happens on your own machine, which is why it is free.',
    },
  },
  {
    id: 'upload',
    icon: '⬆️',
    title: 'YouTube',
    provider: 'YouTube Data API',
    does: 'Uploads the video, sets the thumbnail, title, description and tags, and adds it to your playlist.',
    fields: ['ytPrivacyStatus', 'ytPlaylistId', 'playlistTopic', 'songLanguage', 'songGenre', 'songVocal', 'songMood'],
    test: 'upload',
    testDoes: 'Asks YouTube which channel this login controls, and checks the playlist id really exists.',
    connect: { label: 'Connect YouTube channel', href: '/settings' },
    howTo: {
      title: 'Connect your channel',
      link: '/settings',
      linkLabel: 'Settings → Connect YouTube',
      steps: [
        'Use the Connect YouTube button on the Settings page and pick the channel.',
        'In Google Cloud → APIs & Services → OAuth consent screen, press Publish app. While it says “Testing”, Google expires the login every 7 days.',
        'Create the playlist on your channel, then paste its link or id below.',
      ],
      note: 'Privacy can be public, unlisted or private — set it to unlisted while you are still testing.',
    },
  },
  {
    id: 'storage',
    icon: '💾',
    title: 'Storage',
    provider: 'Google Drive + your PC',
    does: 'Keeps a cloud copy of the newest songs (older ones auto-deleted) and writes every finished song into a folder on the worker PC.',
    fields: ['driveFolderName', 'driveKeepSongs', 'localSavePath'],
    test: 'storage',
    testDoes: 'Opens the Drive folder this app created and reports what is in it.',
    connect: { label: 'Connect Google Drive', href: '/settings' },
    howTo: {
      title: 'Connect Drive (optional)',
      link: '/settings',
      linkLabel: 'Settings → Connect Google Drive',
      steps: [
        'Use the Connect Google Drive button on the Settings page.',
        'Leave the local folder blank to save into a “Songs” folder next to the worker app, or type a path like D:\\Songs.',
      ],
      note: 'Drive is only the cloud copy. Even with Drive disconnected, songs are still saved on the worker PC.',
    },
  },
];

/** The autopilot settings that sit around the pipeline rather than inside it. */
export const SIDE_FIELDS = ['timezone', 'songsPerDay', 'autoRetries'];

export const NODE_IDS = NODES.map((n) => n.id);
