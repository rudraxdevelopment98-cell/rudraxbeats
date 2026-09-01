// pages/index.js
// Dashboard: one-click "Generate Now", schedule enable/time picker, and a
// live-polling job history with per-step status badges.

import { useCallback, useEffect, useRef, useState } from 'react';

const STEP_ORDER = ['lyrics', 'song', 'thumbnail', 'video', 'upload'];

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
  const [jobs, setJobs] = useState([]);
  const [schedule, setSchedule] = useState({ enabled: false, hour: 14, minute: 0 });
  const [generating, setGenerating] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [message, setMessage] = useState('');
  const pollRef = useRef(null);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs?limit=25');
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch (e) {
      /* ignore transient */
    }
  }, []);

  const loadSchedule = useCallback(async () => {
    try {
      const res = await fetch('/api/schedule');
      const data = await res.json();
      setSchedule(data);
    } catch (e) {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadJobs();
    loadSchedule();
    pollRef.current = setInterval(loadJobs, 5000);
    return () => clearInterval(pollRef.current);
  }, [loadJobs, loadSchedule]);

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
      </div>

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
