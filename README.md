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

**Two separate connect buttons, by design.** Google refuses any consent request
that mixes YouTube scopes with another Google API — and even refuses mixing
`youtube.upload` with `youtube`. So the dashboard runs two flows against the
same OAuth client and stores two refresh tokens:

| Button | Scope | Covers |
| --- | --- | --- |
| 🔗 Connect YouTube channel | `youtube` | upload, thumbnail, channel name, playlist add |
| 💾 Connect Google Drive | `drive.file` | storing songs (only files this app creates) |

Both use the same registered redirect URI; the flow is identified by the OAuth
`state` parameter. Sign in with the same Google account for both.

### 3. Deploy the web app (Vercel)
Import the repo, root directory `web/`. Deploy. Then open it and
**Sign in with Google** — the first account to sign in becomes the **owner**.
Add other people under **Settings → Access** (they sign in with their own
Google account; no password sharing).

### 4. Deploy the worker — this is what does the work

Whatever you pick, the setup is the same: **root directory `worker/`** and
**one env var `REDIS_URL`** (the exact value from Vercel). It builds the
`Dockerfile` (Node + full ffmpeg + Noto fonts). Check `GET /health` returns
`{"ok":true,...}`. Every API key comes from the dashboard, so nothing else.

**Free options (pick one):**

| Option | Cost | Notes |
| --- | --- | --- |
| **Your own PC** (recommended) | Free | No cold starts, no limits. See "Run the worker on your own PC" below. Only runs while that PC is on. |
| **Render free web service** | Free | 750 h/month. **Sleeps after ~15 min idle** — the dashboard pings `/health` when it enqueues, which wakes it. Add a free uptime pinger (UptimeRobot / cron-job.org) hitting `/health` every 10 min to keep it awake during long jobs. |
| **Oracle Cloud Free Tier VM** | Free forever | A real always-on ARM VM. More setup (create VM, install Docker, run the image) but no sleeping and no limits. |
| **Fly.io / Koyeb** | Small free allowance | Fine for one song a day. |
| Railway | ~$5 trial then paid | Easiest UX, not free long-term. |

**About sleeping tiers:** enqueuing a job is a Redis write, which does *not*
wake a sleeping service. That's why `/api/generate` and `/api/cron` also send a
cheap HTTP ping to the worker's `/health`. A cold start takes ~30–60 s, then the
job is picked up normally. For the daily cron, the uptime pinger is the reliable
fix.

#### Run the worker on your own PC (free, recommended)

A spare/always-on PC is the best host: no sleeping, no quotas, and rendering is
as fast as the machine.

**1. Install the prerequisites**
- **Node.js 18+** — <https://nodejs.org> (pick the LTS installer)
- **ffmpeg** — optional but recommended, it enables the on-screen song title.
  Windows: `winget install Gyan.FFmpeg` (then reopen the terminal).
  macOS: `brew install ffmpeg`. Linux: `sudo apt install ffmpeg fonts-noto-core`.
  Without it the engine still works — it just skips the title overlay.

**2. Get the code onto that PC**
```bash
git clone https://github.com/<you>/rudraxbeats.git
cd rudraxbeats/worker
```
(Or download the repo ZIP from GitHub and open the `worker` folder.)

**3. Point it at your database**
Copy `.env.example` → `.env`, then paste your `REDIS_URL` into it. Get the value
from Vercel → your project → **Settings → Environment Variables → REDIS_URL**.
That is the only thing you need — every API key comes from the dashboard.

**4. Start it**
- **Windows:** double-click **`start-windows.bat`** (installs deps the first time).
- **macOS/Linux:** `npm install && npm start`

You should see a banner confirming ffmpeg, the Indic font and `redis: configured ✓`,
then `waiting for jobs…`. Open <http://localhost:3001/health> to confirm.

**5. Keep it running after reboot (optional)**
```bash
npm install -g pm2
pm2 start server.js --name song-engine
pm2 save
pm2 startup      # follow the printed command once
```

**Note on the Worker URL setting:** a home PC has no public URL, so leave
**Settings → Video worker → Worker URL** blank (or `http://localhost:3001`).
The worker pulls jobs from Redis by itself — the dashboard never needs to reach
it. The 🧪 Test button for the worker only works for a publicly hosted one.

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

## Video source — hand-made clips (Flow AI etc.) or the cover image

Tools like Flow AI cap how many clips you can make per day, so the engine treats
clips as an **optional upgrade** rather than a requirement:

| Mode (Settings → 🎬 Video source) | What happens |
| --- | --- |
| `auto` *(default)* | Use clips when the folder has some, otherwise the cover image. |
| `clips` | Prefer clips; still falls back to the cover image rather than failing. |
| `thumbnail` | Always the generated cover image + waveform. |

**How to feed it clips:** drop the videos you made into the **`clips`** folder
next to the worker app (it is created on first run, with a note inside). The
engine takes the oldest `Clips per song` files (default 3), scales them all to
1080p30, joins them, loops that montage for the length of the song, then moves
those files into `clips/used` so nothing is ever reused. The dashboard shows how
many clips are still waiting — a stock of 30 clips at 3 per song is 10 days of
video without touching Flow again.

Clips live on the PC rather than Drive on purpose: the Drive connection uses the
`drive.file` scope, which can only see files this app created, so clips uploaded
by hand would be invisible to it.

## Gujarati (and other Indic languages)

Set **Settings → Playlist & content → Song language** to `Gujarati` (the default).
The engine then:

- picks from a **Gujarati/Indian genre palette** (garba, dandiya raas, lokgeet,
  bhajan, sufi, folk-pop…) instead of western tags;
- writes the lyrics in **native ગુજરાતી script**, *and* asks for a **romanized
  transliteration**;
- sends the **romanized** lyrics to Suno — music models pronounce Indic
  languages far better from Latin script — while the **native script** is used
  for the YouTube title, description and on-screen title;
- forces the language into the Suno style tags so the vocal is actually Gujarati;
- titles videos as `ગુજરાતી શીર્ષક | Romanized Title` and adds Gujarati tags and
  hashtags for discovery;
- renders the on-screen title with **Noto Sans Gujarati**, falling back to the
  romanized title if that font is missing.

The same handling applies to Hindi, Marathi, Punjabi, Bengali, Tamil, Telugu,
Kannada, Malayalam, Odia, Urdu, Nepali and Assamese.

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
| Job stuck at "Waiting for the worker" | The worker isn't running, or a free tier is asleep. Open its `/health` once to wake it, and confirm `REDIS_URL` matches Vercel's. |
| Gujarati title shows boxes in the video | The image needs `fonts-noto-core` (the Dockerfile installs it). Without it the engine falls back to the romanized title automatically. |
| "Attach a Vercel KV store" on login | No Redis connected yet, or the app wasn't redeployed after connecting it. |
| Google login button errors | The app origin isn't in **Authorized JavaScript origins**. |
| Song step fails | Suno cookie expired or captcha — re-paste `SUNO_COOKIE`; check `/api/get_limit`. |
| Playlist not updated | Reconnect YouTube in Settings so the token picks up the `youtube` scope. |
| "scopes that cannot be requested together" | Google never allows YouTube scopes alongside other Google APIs. The app now uses two separate flows — click **Connect YouTube channel** and **Connect Google Drive** one after the other. |
| Drive step warns "not connected" | Click **Connect Google Drive** in Settings — it is a second sign-in, separate from YouTube. |
| Thumbnail step warns | Non-fatal — the video falls back to a gradient background. |

## Local development

```bash
cd web && npm install && npm run dev      # http://localhost:3000
cd worker && npm install && REDIS_URL=redis://127.0.0.1:6379 npm start
```

*No secrets are committed. Real values live in the dashboard (Redis) or host env vars.*
