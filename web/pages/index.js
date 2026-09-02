// pages/index.js — motion-based dashboard.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { motion, AnimatePresence } from 'framer-motion';
import { Background, Nav, Card, MotionButton, Toggle, Loader, fadeUp, stagger } from '../components/ui';

const STEPS = ['lyrics', 'song', 'thumbnail', 'video', 'upload'];
const STEP_ICON = { lyrics: '✍️', song: '🎵', thumbnail: '🖼️', video: '🎬', upload: '⬆️' };
const READY_LABEL = { lyrics: 'OpenAI', song: 'Suno', thumbnail: 'Gemini', video: 'Worker', upload: 'YouTube' };
const VIDEO_MODE_LABEL = {
  auto: 'clips → AI scenes',
  scenes: 'AI scenes',
  clips: 'hand-made clips',
  thumbnail: 'cover image',
};

function Segments({ steps }) {
  return (
    <>
      <div className="seg">
        {STEPS.map((s) => {
          const st = steps?.[s] || 'pending';
          return (
            <div key={s} className={`s ${st}`}>
              <motion.div
                className="fill"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: st === 'pending' ? 0 : 1 }}
                style={{ originX: 0 }}
                transition={{ duration: 0.5 }}
              />
            </div>
          );
        })}
      </div>
      <div className="seg-labels">
        {STEPS.map((s) => <span key={s}>{s}</span>)}
      </div>
    </>
  );
}

function JobCard({ job, onAction, busy }) {
  const stalled =
    job.status === 'running' && Date.now() - new Date(job.updatedAt).getTime() > 3 * 60 * 1000;
  const status = stalled ? 'stalled' : job.status;
  return (
    <motion.div
      className="job"
      layout
      variants={fadeUp}
      initial="hidden"
      animate="show"
      exit={{ opacity: 0, scale: 0.97 }}
    >
      <div className="job-top">
        <div>
          <div className="job-title">{job.title || 'Untitled song'}</div>
          <div className="job-meta">
            {new Date(job.createdAt).toLocaleString()} · {job.trigger}
            {job.mood ? ` · ${job.mood}` : ''}
            {job.youtubeUrl ? (
              <>
                {' · '}
                <a href={job.youtubeUrl} target="_blank" rel="noreferrer">watch ↗</a>
              </>
            ) : null}
          </div>
        </div>
        <span className={`badge ${stalled ? 'error' : job.status}`}>{status}</span>
      </div>
      <Segments steps={job.steps} />

      {/* live progress from the worker */}
      {(job.status === 'running' || job.status === 'queued') && (
        <div style={{ marginTop: 12 }}>
          <div className="prog"><motion.div className="prog-fill"
            initial={{ width: 0 }} animate={{ width: `${job.progress || 0}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }} /></div>
          <div className="job-meta" style={{ marginTop: 6 }}>
            {job.progress ? `${job.progress}% · ` : ''}{job.note || 'Working…'}
          </div>
        </div>
      )}

      {job.error ? <div className="job-err">⚠ {job.error}</div> : null}
      {job.nextRetryAt && job.status === 'error' ? (
        <div className="job-meta" style={{ marginTop: 6, color: 'var(--amber)' }}>
          ↻ Retrying automatically at {new Date(job.nextRetryAt).toLocaleTimeString()} — nothing to do.
        </div>
      ) : null}
      {job.status === 'done' && (
        <div className="job-meta" style={{ marginTop: 8 }}>
          {job.videoSource === 'clips' ? `🎬 ${job.clipsUsed} clip(s) used · `
            : job.videoSource === 'scenes' ? `🎨 ${job.scenesUsed} AI scenes · `
              : '🖼️ cover-image video · '}
          {job.playlistAdded ? '🎼 Added to playlist · ' : ''}
          {job.driveFiles?.length ? `💾 ${job.driveFiles.length} file(s) in Drive` : ''}
          {job.localDir ? ` · 📁 saved to ${job.localDir}` : ''}
        </div>
      )}
      {stalled && !job.error ? (
        <div className="job-err" style={{ color: 'var(--amber)', background: 'rgba(251,191,36,.08)', borderColor: 'rgba(251,191,36,.25)' }}>
          ⏳ No progress for &gt;3 min. Long songs do this — and if the worker PC restarted it
          picks this song back up by itself, so there is usually nothing to do.
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <MotionButton className="btn ghost" style={{ padding: '7px 14px', fontSize: 13 }} disabled={busy} onClick={() => onAction(job.id, 'retry')}>↻ Retry</MotionButton>
        {job.status === 'running' && (
          <MotionButton className="btn ghost" style={{ padding: '7px 14px', fontSize: 13 }} disabled={busy} onClick={() => onAction(job.id, 'cancel')}>⏸ Cancel</MotionButton>
        )}
        <MotionButton className="btn danger" style={{ padding: '7px 14px', fontSize: 13 }} disabled={busy} onClick={() => onAction(job.id, 'delete')}>🗑 Delete</MotionButton>
      </div>
    </motion.div>
  );
}

export default function Home() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [schedule, setSchedule] = useState({ enabled: false, hour: 14, minute: 0 });
  const [readiness, setReadiness] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState('');
  const pollRef = useRef(null);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs?limit=25');
      if (res.status === 401) return router.replace('/login');
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch (_) {}
  }, [router]);

  const loadSchedule = useCallback(async () => {
    try {
      const res = await fetch('/api/schedule');
      if (res.ok) setSchedule(await res.json());
    } catch (_) {}
  }, []);

  const loadReadiness = useCallback(async () => {
    try {
      const res = await fetch('/api/config');
      if (res.ok) setReadiness((await res.json()).readiness || null);
    } catch (_) {}
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (!d.authed) return router.replace('/login');
        setUser(d.user || null);
        setReady(true);
        loadJobs();
        loadSchedule();
        loadReadiness();
        pollRef.current = setInterval(() => {
          loadJobs();
          loadReadiness(); // keeps the worker online/offline chip fresh
        }, 5000);
      })
      .catch(() => router.replace('/login'));
    return () => clearInterval(pollRef.current);
  }, [router, loadJobs, loadSchedule, loadReadiness]);

  const generateNow = async () => {
    setGenerating(true);
    setMessage('');
    try {
      const res = await fetch('/api/generate', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start');
      setMessage('Started — watch the progress below.');
      loadJobs();
    } catch (e) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const [actionBusy, setActionBusy] = useState(false);
  const doAction = async (id, action) => {
    setActionBusy(true);
    try {
      await fetch('/api/job-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      await loadJobs();
    } catch (_) {} finally {
      setActionBusy(false);
    }
  };

  const saveSchedule = async (patch) => {
    const next = { ...schedule, ...patch };
    setSchedule(next);
    try {
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (res.ok) setSchedule(await res.json());
    } catch (_) {}
  };

  const allReady = readiness && STEPS.every((s) => readiness[s]);
  const auto = readiness?.autopilot || null;
  const alert = readiness?.alert || null;

  if (!ready) return <Loader />;

  return (
    <>
      <Background />
      <Nav user={user} />
      <div className="shell">
        {/* The one thing that can still need a human: an expired Suno cookie. */}
        <AnimatePresence>
          {alert && (
            <motion.div className="alert" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              ⚠ {alert.text}
            </motion.div>
          )}
        </AnimatePresence>

        {/* HERO */}
        <Card className="hero" delay={0.02}>
          <div className="eyebrow">DAILY · AUTOMATED</div>
          <h1>Today&apos;s song, on autopilot 🎧</h1>
          <p>Generate a fresh AI song — lyrics, music, thumbnail, video and YouTube upload — in one click, or let the daily schedule do it.</p>
          <div className="hero-row">
            <MotionButton className="btn lg" onClick={generateNow} disabled={generating}>
              {generating ? <><span className="spin" /> Starting…</> : <>⚡ Generate Now</>}
            </MotionButton>
            <MotionButton className="btn ghost" onClick={loadJobs}>↻ Refresh</MotionButton>
            <AnimatePresence>
              {message && (
                <motion.span className="hint" style={{ margin: 0 }} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                  {message}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </Card>

        {/* SETUP STATUS */}
        {readiness && (
          <Card delay={0.08}>
            <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>Setup status {allReady ? '· ready ✅' : '· needs setup'}</span>
            <span className="row" style={{ gap: 8 }}>
              {readiness.workerOnline && readiness.workerInfo?.clipsAvailable != null && (
                <span className={`tag ${readiness.workerInfo.clipsAvailable > 0 ? 'ok' : ''}`}
                  style={{ textTransform: 'none', letterSpacing: 0 }}
                  title="Hand-made clips waiting in the worker's clips folder">
                  🎬 {readiness.workerInfo.clipsAvailable} clip{readiness.workerInfo.clipsAvailable === 1 ? '' : 's'}
                </span>
              )}
              <span className={`tag ${readiness.workerOnline ? 'ok' : ''}`} style={{ textTransform: 'none', letterSpacing: 0 }}>
                {readiness.workerOnline
                  ? `● Worker online${readiness.workerInfo?.platform ? ` (${readiness.workerInfo.platform})` : ''}`
                  : '○ Worker offline'}
              </span>
            </span>
          </div>
            <motion.div className="stepper" variants={stagger} initial="hidden" animate="show">
              {STEPS.map((s) => (
                <motion.div key={s} className={`node ${readiness[s] ? 'ok' : 'no'}`} variants={fadeUp}>
                  <span className="tick">{readiness[s] ? '✓' : '•'}</span>
                  <div className="ic">{STEP_ICON[s]}</div>
                  <div className="lbl">{READY_LABEL[s]}</div>
                </motion.div>
              ))}
            </motion.div>
            {!allReady && (
              <div className="hint">Add the missing keys in <a href="/settings" style={{ color: 'var(--violet)', fontWeight: 600 }}>Settings</a> before generating.</div>
            )}
          </Card>
        )}

        {/* AUTOPILOT */}
        <Card delay={0.12}>
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>🤖 Autopilot</span>
            {auto?.nextRun && schedule.enabled ? (
              <span className="tag ok" style={{ textTransform: 'none', letterSpacing: 0 }}>
                next run {auto.nextRun}
              </span>
            ) : null}
          </div>
          <div className="row">
            <Toggle on={schedule.enabled} onClick={() => saveSchedule({ enabled: !schedule.enabled })} />
            <span style={{ fontWeight: 600, color: schedule.enabled ? 'var(--green)' : 'var(--muted)' }}>
              {schedule.enabled ? 'Running every day, by itself' : 'Paused'}
            </span>
            <span className="spacer" />
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>
              Time ({auto?.timezone || 'your timezone'})
            </span>
            <input className="input num" type="number" min="0" max="23" value={schedule.hour}
              onChange={(e) => setSchedule({ ...schedule, hour: Number(e.target.value) })} onBlur={() => saveSchedule({})} />
            <span>:</span>
            <input className="input num" type="number" min="0" max="59" value={schedule.minute}
              onChange={(e) => setSchedule({ ...schedule, minute: Number(e.target.value) })} onBlur={() => saveSchedule({})} />
          </div>

          <motion.div className="auto-grid" variants={stagger} initial="hidden" animate="show">
            {[
              ['🎬', 'Visuals', VIDEO_MODE_LABEL[auto?.videoMode || 'auto'] || 'AI scenes'],
              ['🎵', 'Songs per day', auto?.songsPerDay ?? 1],
              ['↻', 'Auto-retry', auto?.autoRetries ? `${auto.autoRetries}× on failure` : 'off'],
              ['📁', 'Saved to PC', auto?.localSave ? 'yes' : 'not set'],
            ].map(([ic, label, value]) => (
              <motion.div key={label} className="auto-cell" variants={fadeUp}>
                <div className="ic">{ic}</div>
                <div>
                  <div className="lbl">{label}</div>
                  <div className="val">{value}</div>
                </div>
              </motion.div>
            ))}
          </motion.div>

          <div className="hint">
            The worker on your PC fires the run itself at this time — changing it here takes
            effect immediately, no redeploy. Failed runs retry on their own, and a PC restart
            picks the song back up where it stopped.
          </div>
        </Card>

        {/* JOBS */}
        <div className="section-eyebrow">
          <h2>Recent songs</h2>
          <span className="count">{jobs.length}</span>
        </div>
        {jobs.length === 0 ? (
          <div className="empty">No songs yet. Hit <b>Generate Now</b> to create your first one.</div>
        ) : (
          <motion.div variants={stagger} initial="hidden" animate="show">
            <AnimatePresence initial={false}>
              {jobs.map((job) => <JobCard key={job.id} job={job} onAction={doAction} busy={actionBusy} />)}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
    </>
  );
}
