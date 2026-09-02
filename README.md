# 🎵 AI Song Engine

A hands-off engine for a daily AI-song YouTube channel. One click (or a daily
schedule) writes lyrics, generates the song, makes cover art, renders a video,
stores it in Google Drive, uploads to YouTube and adds it to your playlist —
with live progress in a dashboard.

```
   Dashboard "Generate Now"          Vercel Cron (daily)
              │                              │
              └───────────► Redis queue ◄────┘        (Vercel only enqueues —
                                 │                      it never runs the work)
                                 ▼
                    ALWAYS-ON WORKER  (Railway / Render)
                                 │
   ①  lyrics      OpenAI ─────── writes a song about your playlist's subject
   ②  song        Suno wrapper ─ your own Suno Pro account
   ③  cover art   Gemini image
   ④  video       ffmpeg ─────── Ken-Burns still + waveform + title
   ⑤  storage     Google Drive ─ keeps the newest N songs, deletes older
   ⑥  publish     YouTube ────── upload + thumbnail + add to playlist
                                 │
                                 ▼
                 progress written to Redis after every stage
                        (dashboard polls and shows it live)
```

**Why a separate worker?** Vercel functions are killed after ~10–60s, but a song
takes minutes. So Vercel hosts the dashboard and only pushes a job onto a Redis
queue; the always-on worker does all the long work. This is what makes
"one click" and the daily schedule actually complete.

| Service | Folder | Host | Role |
| --- | --- | --- | --- |
| Dashboard + API + cron | `web/` | **Vercel** | UI, settings, auth, enqueue |
| Pipeline runner | `worker/` | **Railway / Render** | does all the actual work |
| Local downloader (optional) | `tools/` | your PC | Drive → your folder |

---

## ⚠️ Read this first — what is and isn't possible

- **Suno has no official API.** A Pro subscription gives you credits on
  suno.com, not API access. This engine talks to a **self-hosted
  [gcui-art/suno-api](https://github.com/gcui-art/suno-api)** wrapper that uses
  *your own* Suno cookie, so your Pro credits are what get used. It's unofficial
  and the cookie expires periodically — expect occasional re-pasting. A paid
  third-party wrapper is supported too (`Mode = generic`).
- **ChatGPT-free and Google Flow (Veo) free have no API.** Automating them means
  browser-botting logins across accounts — against their terms and constantly
  breaking. Lyrics therefore use the (very cheap) OpenAI API, and the video is
  rendered locally with ffmpeg, which costs nothing.
- **No website can save files onto your computer.** Browsers forbid it. So songs
  go to **Google Drive**; to get them on your PC either install **Google Drive
  for Desktop** (it syncs automatically — easiest) or run `tools/sync-local.js`.
- **YouTube and repetitive AI content.** Channels that look mass-produced can get
  demoted. The engine varies the angle, title, mood and tags on every song —
  still, add human touches now and then.

---

## Setup

### 1. Redis (the shared database) — 2 minutes
Vercel → your project → **Storage** → **Create Database** → **Redis / Upstash** →
**Connect** to the project → **Redeploy**.
This gives the project a `REDIS_URL`. The web app and the worker both use it.

### 2. Google Cloud (one OAuth client covers login, YouTube, Drive)
1. Enable **YouTube Data API v3** and **Google Drive API**.
2. Create an OAuth client, type **Web application**.
3. **Authorized JavaScript origins**: `https://<your-app>.vercel.app`
4. **Authorized redirect URIs**: `https://<your-app>.vercel.app/api/oauth/youtube/callback`
5. Add every user's Google account as a **Test user** on the consent screen.

The Client **ID** is public and already shipped as a default (override with the
`GOOGLE_CLIENT_ID` env var). The Client **secret** goes in the dashboard only.

Scopes requested: `youtube.upload`, `youtube` (playlists), `youtube.readonly`,
`drive.file` (only files this app creates).

### 3. Deploy the web app (Vercel)
Import the repo, root directory `web/`. Deploy. Then open it and
**Sign in with Google** — the first account to sign in becomes the **owner**.
Add other people under **Settings → Access** (they sign in with their own
Google account; no password sharing).

### 4. Deploy the worker (Railway or Render) — this is what does the work
1. New Project → Deploy from GitHub → this repo → **root directory `worker/`**.
2. It builds the `Dockerfile` (Node + full ffmpeg with `drawtext` + fonts).
3. Set **one** env var: **`REDIS_URL`** — the exact same value as in Vercel.
4. Deploy. `GET /health` should return `{"ok":true,...}`.

The worker reads every API key from the same settings the dashboard writes, so
there is nothing else to configure there.

### 5. Self-host the Suno wrapper (uses your Suno Pro)
1. Deploy [gcui-art/suno-api](https://github.com/gcui-art/suno-api) with its
   "Deploy with Vercel" button.
2. Get your Suno cookie: log in to suno.com → F12 → **Network** → a
   `clerk.suno.com` request → **Request Headers** → copy the whole `Cookie`
   value → set it as `SUNO_COOKIE` there → redeploy.
   (Suno now shows captchas; you may also need `TWOCAPTCHA_KEY`.)
3. Check `https://<your-suno-api>.vercel.app/api/get_limit` shows your credits.

### 6. Fill in the dashboard
**Settings** → paste and **Save**, then hit each **🧪 Test** button:

| Section | What to enter |
| --- | --- |
| ✍️ Lyrics | OpenAI API key |
| 🎵 Song | Your suno-api URL (Mode `suno-api`) |
| 🖼️ Thumbnail | Gemini API key (free tier is fine) |
| 🎬 Video worker | Your Railway/Render worker URL + a shared secret |
| ⬆️ YouTube | Client secret, then **Connect YouTube channel** |
| 🎼 Playlist & content | Playlist ID/URL + the subject every song should be about |
| 💾 Storage | Drive folder name, how many songs to keep (default 4) |

### 7. Go
- **⚡ Generate Now** — one click, full pipeline, live progress.
- **Daily schedule** — flip the toggle on. The cron time lives in
  `web/vercel.json` (`0 14 * * *` = 14:00 UTC); change it there and redeploy.

---

## Playlist-driven content

Set **Playlist ID/URL** and **Playlist subject** in Settings. Then:
- every song is written *about that subject*, with a different angle each run
  (a memory, a celebration, a goodbye…) so tracks stay distinct;
- after upload the video is **added to that playlist** automatically.

Want a second category? Change the subject and playlist, and the next songs
follow the new theme.

## Storage & retention

Every finished song stores three files in the Drive folder — `<jobId>__<title>.mp4`,
`.mp3` and `.png`. After each successful run the worker keeps the **newest N
songs** (default **4**) and permanently deletes everything older, so Drive never
fills up. Change N in **Settings → Storage**.

## Getting songs onto your computer

**Easiest:** install **Google Drive for Desktop** and pick where the Drive
folder lives — new songs appear there automatically.

**Or** run the included downloader on your PC:
```bash
cd tools
npm install
YT_CLIENT_ID=... YT_CLIENT_SECRET=... YT_REFRESH_TOKEN=... \
LOCAL_SAVE_PATH="D:\\Songs" node sync-local.js
```
It polls Drive and saves anything new into that folder.

---

## API reference

**Web (Vercel)**

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/generate` | POST | Create a job and enqueue it (returns instantly) |
| `/api/cron` | GET | Vercel Cron entry; enqueues if the schedule is enabled |
| `/api/jobs` | GET | Recent jobs + live progress |
| `/api/job-action` | POST | `{ id, action: retry \| cancel \| delete }` |
| `/api/config` | GET/POST | Settings (secrets masked) |
| `/api/test?target=` | GET | Live check of `openai \| suno \| gemini \| worker` |
| `/api/access` | GET/POST | Owner-only allowlist of Google emails |
| `/api/youtube/status` | GET | Connected channel |

**Worker**

| Route | Purpose |
| --- | --- |
| `/health` | Uptime + processed/failed counters + current job |

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Job stuck at "Waiting for the worker" | The worker isn't running. Check its `/health` and that `REDIS_URL` matches Vercel's. |
| "Attach a Vercel KV store" on login | No Redis connected yet, or the app wasn't redeployed after connecting it. |
| Google login button errors | The app origin isn't in **Authorized JavaScript origins**. |
| Song step fails | Suno cookie expired or captcha — re-paste `SUNO_COOKIE`; check `/api/get_limit`. |
| Playlist not updated | Reconnect YouTube in Settings so the token picks up the `youtube` scope. |
| Thumbnail step warns | Non-fatal — the video falls back to a gradient background. |

## Local development

```bash
cd web && npm install && npm run dev      # http://localhost:3000
cd worker && npm install && REDIS_URL=redis://127.0.0.1:6379 npm start
```

*No secrets are committed. Real values live in the dashboard (Redis) or host env vars.*
