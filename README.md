# 🎵 AI Song Engine

A web-based engine that **fully automates a daily AI-generated-song YouTube channel**. It writes the lyrics, generates the song, renders a video, generates a thumbnail, and uploads to YouTube — from a one-click button or a daily schedule.

```
Vercel Cron / "Generate Now"
        │
        ▼
  /api/generate ──► lib/pipeline.js
        │
        ├─ 1. lyrics    OpenAI Chat Completions      → {title, lyrics, style, mood}
        ├─ 2. song      third-party Suno wrapper API  → audioUrl
        ├─ 3. thumbnail Gemini image model            → base64 PNG
        ├─ 4. video     worker POST /render (ffmpeg)   → public videoUrl
        └─ 5. upload    YouTube Data API v3            → youtube.com/watch?v=…
        │
        ▼
  job status written to Vercel KV after every step (dashboard polls it)
```

Two deployables:

| Service | Folder | Host | Why |
| --- | --- | --- | --- |
| **Web app** (dashboard + API + cron) | `web/` | **Vercel** | Next.js, serverless, free Cron |
| **Render worker** (ffmpeg) | `worker/` | **Railway / Render** | ffmpeg needs a long-running, non-serverless process |

---

## ⚠️ Read this first — free tools vs. APIs

The original idea (Suno for songs, ChatGPT-free for lyrics, Google **Flow/Veo** free plan for video across multiple Google accounts) **cannot be automated reliably or within terms of service:**

- **ChatGPT free** and **Google Flow (Veo)** have **no public API on the free tier.** Automating them means driving a headless browser and rotating logins across many Google accounts — this breaks their ToS, gets accounts flagged/banned, and shatters every time the UI changes. It is not a foundation you can run a daily channel on.
- **Suno** has **no official public API** either (as of 2026). The only programmatic access is unofficial third-party wrappers (Apiframe, MusicAPI, Crazyrouter, …), which carry vendor + ToS risk.

So this engine is built on the **automatable path**, exactly as the project spec pivoted to:

- **Lyrics** → OpenAI API (cheap; `gpt-4o-mini`).
- **Song** → a third-party Suno wrapper (pluggable — you supply the provider).
- **Thumbnail** → Google Gemini image API (has a generous free tier).
- **Video** → **your own** ffmpeg worker (no third party, no per-render cost) that turns the song + thumbnail into a real 1080p video with a Ken-Burns background, a waveform, and a title overlay.
- **Upload** → official YouTube Data API v3.

Every provider is behind a small `lib/*.js` module, so if a cheaper or free-tier option appears you swap one file. If you still want the browser-automation route for a specific tool, that's a separate, fragile add-on — keep it isolated from this pipeline.

---

## Repository layout

```
web/
  package.json            Next.js + @vercel/kv + googleapis
  vercel.json             daily Cron → /api/cron  +  function maxDuration
  next.config.js
  .env.example            all web env vars (copy to .env.local)
  lib/
    db.js                 Vercel KV helpers (jobs + schedule)
    lyrics.js             generateLyrics()   – OpenAI
    song.js               generateSong()     – third-party Suno wrapper
    thumbnail.js          generateThumbnail()– Gemini image
    worker.js             renderVideo()      – calls the worker
    youtube.js            uploadToYoutube()  – YouTube Data API v3
    pipeline.js           runPipeline()      – orchestrates + writes KV
  pages/
    index.js              dashboard: Generate Now, schedule, job history
    api/generate.js       POST manual trigger (fire-and-forget)
    api/cron.js           daily Cron entry (gated by KV schedule.enabled)
    api/schedule.js       GET/POST schedule
    api/jobs.js           GET recent jobs
  scripts/
    get-refresh-token.js  one-time YouTube OAuth helper
  styles/globals.css

worker/
  package.json            express + ffmpeg-static + @vercel/blob
  server.js               POST /render (bearer-protected) → ffmpeg → storage
  Dockerfile              node + full ffmpeg (with drawtext) + fonts
  .env.example
```

---

## Prerequisites (accounts & keys)

1. **OpenAI** — API key from <https://platform.openai.com>.
2. **Suno wrapper** — sign up with one of Apiframe / MusicAPI / Crazyrouter and get its base URL + API key. *(No official Suno API exists.)*
3. **Gemini** — API key from <https://aistudio.google.com>.
4. **Google Cloud / YouTube** — a project with **YouTube Data API v3** enabled and an **OAuth 2.0 Client** of type **Desktop app**.
5. **Video storage** — either a **Vercel Blob** store (recommended) *or* just let the worker serve files from itself (fallback).
6. Accounts on **Vercel** (web) and **Railway** or **Render** (worker).

---

## Setup — step by step

### 1. Deploy the worker first (Railway or Render)

The web app needs the worker's public URL, so build it first.

**Local smoke test (optional):**
```bash
cd worker
npm install
WORKER_SECRET=devsecret PUBLIC_BASE_URL=http://localhost:3001 npm start
# in another shell:
curl -X POST http://localhost:3001/render \
  -H "Authorization: Bearer devsecret" -H "Content-Type: application/json" \
  -d '{"audioUrl":"https://download.samplelib.com/mp3/sample-9s.mp3","title":"Test Song"}'
# → { "ok": true, "videoUrl": "...", "durationSec": ... }
```

> **ffmpeg note:** the Docker image installs a **full ffmpeg** (with the `drawtext` filter) so the title overlay renders. The npm `ffmpeg-static` binary lacks `drawtext`; the worker auto-detects this and simply **skips the title overlay** rather than failing, so it still works locally even without a system ffmpeg.

**Deploy (Railway example):**
1. New Project → Deploy from GitHub repo → pick this repo, set **root directory** to `worker/`.
2. Railway builds the `Dockerfile` automatically.
3. Set env vars:
   - `WORKER_SECRET` — a long random string (remember it; the web app must match).
   - **Storage — pick one:**
     - `BLOB_READ_WRITE_TOKEN` — from a Vercel Blob store *(recommended)*, **or**
     - `PUBLIC_BASE_URL` — the worker's own public URL (Railway gives you one), used by the local-file fallback.
4. Deploy → copy the public URL, e.g. `https://your-worker.up.railway.app`.

Render is equivalent: **New → Web Service → Docker**, root `worker/`, same env vars.

### 2. Deploy the web app (Vercel)

1. **Import** the repo in Vercel, set **root directory** to `web/`.
2. **Attach a KV store:** Vercel dashboard → Storage → create **KV** (Upstash Redis) and connect it to the project. This auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`. **This is the only thing you must set in Vercel.**
3. Deploy.

### 2b. Configure everything from the in-app Settings page (no env vars needed)

Once KV is attached and the site is deployed, **you manage all API keys inside the dashboard** — you do *not* need to add them as Vercel env vars.

1. Open the site. On first visit it asks you to **create an admin password** (this protects your keys, since the site is public). Remember it.
2. Go to **⚙️ Settings** and paste in each value: OpenAI key, Suno provider URL + key, Gemini key, Worker URL + secret, YouTube client id/secret/refresh token. Secrets are stored in KV and shown masked.
3. The dashboard shows a **Setup status** row so you can see which steps are ready.

> Env vars still work as a fallback if you prefer them (see `web/.env.example`) — a Settings value simply overrides the matching env var. The only env var that *must* be set in Vercel for the daily cron to be protected is `CRON_SECRET` (optional but recommended).

### 3. One-time YouTube OAuth (get the refresh token)

Do this **once**, locally, signed in as the **channel owner**:

```bash
cd web
npm install
YT_CLIENT_ID=xxx YT_CLIENT_SECRET=yyy npm run get-refresh-token
```

It prints a Google consent URL. Open it **in a browser logged into the target YouTube channel's Google account**, approve, paste the code back, and it prints the **refresh token**. Put that in Vercel as `YT_REFRESH_TOKEN` and redeploy.

- The OAuth client must be **Desktop app** type (uses the out-of-band redirect).
- Add the channel's Google account as a **Test user** on the OAuth consent screen (or publish the app).
- Scope requested: `youtube.upload` only (least privilege).

### 4. Test end-to-end, then enable the daily run

1. Open the deployed dashboard → **Generate Now**. Watch the job walk through `lyrics → song → thumbnail → video → upload`.
2. When a run reaches **upload** and you get a YouTube link, flip the **schedule toggle to Enabled**.
3. The daily Cron (see below) will now run automatically.

---

## The daily schedule (important nuance)

- The Cron **time** is fixed in `web/vercel.json`:
  ```json
  { "crons": [{ "path": "/api/cron", "schedule": "0 14 * * *" }] }
  ```
  That's **14:00 UTC** daily. Vercel Cron schedules are **static at deploy time** — they cannot be changed from the running app.
- The dashboard's **Enabled/Disabled toggle** is the live **gate**: `/api/cron` checks `schedule.enabled` in KV and skips the run when off. Use it to pause/resume without redeploying.
- The **hour/minute** fields in the dashboard are **informational** (stored in KV for reference). **To actually change when Cron fires, edit the cron expression in `vercel.json` and redeploy.**

  Cron format is `minute hour day month weekday`, in **UTC**. e.g. `30 9 * * *` = 09:30 UTC daily.

---

## API reference (web)

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/generate` | POST | Start a pipeline run now; returns `{ jobId }` immediately (202). |
| `/api/cron` | GET | Vercel Cron entry; runs only if `schedule.enabled`. Requires `Bearer $CRON_SECRET`. |
| `/api/schedule` | GET / POST | Read / update `{ enabled, hour, minute }`. |
| `/api/jobs?limit=25` | GET | Recent jobs for the dashboard. |

Worker:

| Route | Method | Purpose |
| --- | --- | --- |
| `/render` | POST | `{ audioUrl, title, thumbnailBase64, durationSec? }` → `{ videoUrl, durationSec }`. Requires `Bearer $WORKER_SECRET`. |
| `/health` | GET | Liveness check. |

---

## Known risks & things to watch (please read)

- **YouTube reach/monetization:** channels that look like mass-produced, repetitive AI content can get demoted or demonetized. The pipeline already **randomizes theme + genre** per run and varies titles/descriptions/tags — keep adding human variation (occasional manual titles/thumbnails) and don't upload obvious near-duplicates.
- **Third-party Suno wrappers are unofficial.** They can break or lose Suno access without notice (vendor + ToS risk). `lib/song.js` fails loudly and marks the job errored so you get an alert on the dashboard; keep a second provider ready to swap via env vars.
- **Serverless timeouts.** Vercel functions cap at ~10s (Hobby) / 60s+ (Pro). `/api/generate` and `/api/cron` therefore **kick off the pipeline and return immediately** (`202`) instead of blocking. For a **Hobby plan or heavier daily use, move `runPipeline()` onto a durable queue/worker** (e.g. run the whole pipeline inside the always-on worker, or use QStash/Inngest) so a frozen serverless function can't kill a run mid-way. See "Scaling" below.
- **The YouTube refresh token is a production secret.** It's long-lived and grants uploads to the channel. Store it only in the host's secret manager, restrict the scope to `youtube.upload`, and rotate it if leaked.
- **Cost.** OpenAI + the Suno wrapper are the paid pieces; Gemini image + YouTube API + your own ffmpeg worker are effectively free. One song/day is cheap, but watch the Suno wrapper's per-generation pricing.

## Scaling / hardening (beyond MVP)

- Run the **entire pipeline inside the worker** (it's already always-on) and have `/api/generate` just enqueue a request — removes the serverless-timeout risk entirely.
- Add a **notification** (email/Discord/Slack) on job failure so a broken Suno provider is visible immediately.
- Add **retry with backoff** around the Suno poll and the YouTube upload.
- Persist rendered videos to durable storage (Vercel Blob / S3) rather than the worker's ephemeral disk if you use the local-file fallback.

---

## Local development

```bash
# web
cd web && npm install && npm run dev      # http://localhost:3000
# (without KV env vars it uses an in-memory job store — state resets on restart)

# worker
cd worker && npm install && npm start     # http://localhost:3001
```

---

*Nothing in this repo commits secrets — real values go in host env vars only. `.env.example` files document every variable.*
