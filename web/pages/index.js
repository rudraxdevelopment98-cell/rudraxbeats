// pages/index.js
// Dashboard: one-click "Generate Now", schedule enable/time picker, and a
// live-polling job history with per-step status badges.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';

const STEP_ORDER = ['lyrics', 'song', 'thumbnail', 'video', 'upload'];
const STEP_LABELS = {
  lyrics: 'OpenAI key',
  song: 'Suno provider',
  thumbnail: 'Gemini key',
  video: 'Worker URL',
  upload: 'YouTube auth',
};

function StepPill({ name, status }) {
  return (
    <span className={`step ${status}`}>
      <span className="s" />
      {name}
    </span>
  );
}

function JobCard({ job }) {
  const when = new Date(job.createdAt).toLocaleString();
  return (
    <div className="job">
      <div className="top">
        <div className="title">{job.title || 'Untitled song'}</div>
        <span className={`badge ${job.status}`}>{job.status}</span>
      </div>
      <div className="meta">
        {when} · {job.trigger}
        {job.mood ? ` · ${job.mood}` : ''}
        {job.youtubeUrl ? (
          <>
            {' · '}
            <a href={job.youtubeUrl} target="_blank" rel="noreferrer">
              watch on YouTube ↗
            </a>
          </>
        ) : null}
      </div>
      <div className="steps">
        {STEP_ORDER.map((s) => (
          <StepPill key={s} name={s} status={job.steps?.[s] || 'pending'} />
        ))}
      </div>
      {job.error ? <div className="err">⚠ {job.error}</div> : null}
    </div>
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
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [message, setMessage] = useState('');
  const pollRef = useRef(null);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs?limit=25');
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch (e) {
      /* ignore transient */
    }
  }, [router]);

  const loadSchedule = useCallback(async () => {
    try {
      const res = await fetch('/api/schedule');
      if (res.status === 401) return;
      const data = await res.json();
      setSchedule(data);
    } catch (e) {
      /* ignore */
    }
  }, []);

  const loadReadiness = useCallback(async () => {
    try {
      const res = await fetch('/api/config');
      if (res.status === 401) return;
      const data = await res.json();
      setReadiness(data.readiness || null);
    } catch (e) {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Gate the page behind auth first.
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (!d.authed) {
          router.replace('/login');
          return;
        }
        setUser(d.user || null);
        setReady(true);
        loadJobs();
        loadSchedule();
        loadReadiness();
        pollRef.current = setInterval(loadJobs, 5000);
      })
      .catch(() => router.replace('/login'));
    return () => clearInterval(pollRef.current);
  }, [router, loadJobs, loadSchedule, loadReadiness]);

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  };

  if (!ready) {
    return (
      <div className="wrap">
        <div className="card">Loading…</div>
      </div>
    );
  }

  const generateNow = async () => {
    setGenerating(true);
    setMessage('');
    try {
      const res = await fetch('/api/generate', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start');
      setMessage(`Started job ${data.jobId}. Watch the progress below.`);
      loadJobs();
    } catch (e) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const saveSchedule = async (patch) => {
    setSavingSchedule(true);
    try {
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...schedule, ...patch }),
      });
      const data = await res.json();
      setSchedule(data);
    } catch (e) {
      setMessage(`Error saving schedule: ${e.message}`);
    } finally {
      setSavingSchedule(false);
    }
  };

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <h1>🎵 AI Song Engine</h1>
          <div className="sub">
            Daily AI-generated songs → YouTube, fully automated.
          </div>
        </div>
        <div className="row">
          {user ? <span className="meta">{user.email}</span> : null}
          <Link href="/settings" className="navlink">⚙️ Settings</Link>
          <button className="secondary" onClick={logout}>Log out</button>
        </div>
      </div>

      {readiness ? (
        <div className="card">
          <h2>Setup status</h2>
          <div className="steps">
            {STEP_ORDER.map((s) => (
              <span key={s} className={`step ${readiness[s] ? 'done' : 'error'}`}>
                <span className="s" />
                {STEP_LABELS[s]}
              </span>
            ))}
          </div>
          {STEP_ORDER.some((s) => !readiness[s]) ? (
            <div className="hint">
              Missing keys above. Add them on the{' '}
              <Link href="/settings">Settings</Link> page before generating.
            </div>
          ) : (
            <div className="hint">All set — you can generate a song. ✅</div>
          )}
        </div>
      ) : null}

      <div className="card">
        <h2>Manual trigger</h2>
        <div className="row">
          <button onClick={generateNow} disabled={generating}>
            {generating ? 'Starting…' : '⚡ Generate Now'}
          </button>
          <button className="secondary" onClick={loadJobs}>
            Refresh
          </button>
        </div>
        {message ? <div className="hint">{message}</div> : null}
      </div>

      <div className="card">
        <h2>Daily schedule</h2>
        <div className="row">
          <button
            className="secondary"
            onClick={() => saveSchedule({ enabled: !schedule.enabled })}
            disabled={savingSchedule}
          >
            <span className="toggle">
              <span className={`dot ${schedule.enabled ? 'on' : ''}`} />
              {schedule.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </button>

          <label>Time (UTC):</label>
          <input
            type="number"
            min="0"
            max="23"
            value={schedule.hour}
            onChange={(e) => setSchedule({ ...schedule, hour: Number(e.target.value) })}
            onBlur={() => saveSchedule({})}
          />
          <span>:</span>
          <input
            type="number"
            min="0"
            max="59"
            value={schedule.minute}
            onChange={(e) => setSchedule({ ...schedule, minute: Number(e.target.value) })}
            onBlur={() => saveSchedule({})}
          />
        </div>
        <div className="notice">
          The toggle enables/disables the daily run immediately. Changing the
          time here is informational — the actual Vercel Cron fire time is set
          in <code>vercel.json</code> and requires a redeploy to change (see
          README).
        </div>
      </div>

      <div className="card">
        <h2>Recent jobs</h2>
        <div className="jobs">
          {jobs.length === 0 ? (
            <div className="empty">No jobs yet. Hit “Generate Now” to start one.</div>
          ) : (
            jobs.map((job) => <JobCard key={job.id} job={job} />)
          )}
        </div>
      </div>
    </div>
  );
}
