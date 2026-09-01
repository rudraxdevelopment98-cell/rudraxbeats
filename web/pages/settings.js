// pages/settings.js
// The dashboard Settings page: enter every API key / URL here instead of
// Vercel env vars. Secrets are shown masked; leaving a secret field blank
// keeps the existing value. Saves to KV via /api/config.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';

const GROUP_ORDER = [
  'Lyrics (OpenAI)',
  'Song (Suno wrapper)',
  'Thumbnail (Gemini)',
  'Video worker',
  'YouTube upload',
];

const YT_MESSAGES = {
  connected: { kind: 'ok', text: '✅ YouTube channel connected.' },
  norefresh: {
    kind: 'warn',
    text:
      'Google did not return a refresh token. Revoke this app at ' +
      'myaccount.google.com/permissions, then Connect again.',
  },
  error: { kind: 'warn', text: '⚠ Could not connect' },
};

export default function Settings() {
  const router = useRouter();
  const [fields, setFields] = useState(null);
  const [values, setValues] = useState({}); // key -> new input value
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [yt, setYt] = useState(null); // { connected, channel, redirectUri, error }

  const loadYt = useCallback(async () => {
    try {
      const res = await fetch('/api/youtube/status');
      if (res.status === 401) return;
      setYt(await res.json());
    } catch (_) {
      /* ignore */
    }
  }, []);

  const load = useCallback(async () => {
    const res = await fetch('/api/config');
    if (res.status === 401) return router.replace('/login');
    const data = await res.json();
    setFields(data.fields);
    // Prefill non-secret fields with their current values.
    const init = {};
    for (const [k, f] of Object.entries(data.fields)) {
      if (!f.secret) init[k] = f.value ?? '';
    }
    setValues(init);
  }, [router]);

  useEffect(() => {
    load();
    loadYt();
  }, [load, loadYt]);

  const disconnectYt = async () => {
    await fetch('/api/youtube/disconnect', { method: 'POST' });
    loadYt();
    load();
  };

  // Query param feedback after the OAuth round-trip.
  const ytParam = router.query.youtube;
  const ytMsg = ytParam ? YT_MESSAGES[ytParam] : null;
  const ytReason = router.query.reason;

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      // Only send secret fields that were actually typed into (non-empty).
      const patch = {};
      for (const [k, f] of Object.entries(fields)) {
        const v = values[k];
        if (f.secret) {
          if (v && v.trim() !== '') patch[k] = v;
        } else {
          patch[k] = v ?? '';
        }
      }
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setFields(data.fields);
      // clear secret inputs after save
      setValues((prev) => {
        const next = { ...prev };
        for (const [k, f] of Object.entries(data.fields)) if (f.secret) next[k] = '';
        return next;
      });
      setMessage('Saved ✓');
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!fields) {
    return (
      <div className="wrap">
        <div className="card">Loading settings…</div>
      </div>
    );
  }

  const grouped = {};
  for (const [k, f] of Object.entries(fields)) {
    (grouped[f.group] = grouped[f.group] || []).push([k, f]);
  }

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <h1>⚙️ Settings</h1>
          <div className="sub">Keys are stored in your KV database, not in code.</div>
        </div>
        <Link href="/" className="navlink">← Back to dashboard</Link>
      </div>

      <div className="card">
        <h2>🔗 Connect YouTube channel</h2>
        {yt && yt.connected ? (
          <div className="yt-connected">
            {yt.channel?.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={yt.channel.thumbnail} alt="" className="yt-avatar" />
            ) : null}
            <div>
              <div className="yt-title">Connected as <b>{yt.channel?.title}</b></div>
              <div className="meta">Uploads will go to this channel.</div>
            </div>
            <div style={{ marginLeft: 'auto' }} className="row">
              <a className="navlink" href="/api/oauth/youtube/start">Change account</a>
              <button type="button" className="secondary" onClick={disconnectYt}>Disconnect</button>
            </div>
          </div>
        ) : (
          <>
            <p className="sub" style={{ marginTop: 0 }}>
              Click connect, then <b>pick the Google account that owns your channel</b>.
              The refresh token is captured automatically — no scripts.
            </p>
            <a className="connect-btn" href="/api/oauth/youtube/start">
              Connect YouTube channel
            </a>
            {yt && yt.error ? <div className="hint">Status: {yt.error}</div> : null}
          </>
        )}

        {ytMsg ? (
          <div className={ytMsg.kind === 'ok' ? 'yt-ok' : 'notice'} style={{ marginTop: 14 }}>
            {ytMsg.text}{ytParam === 'error' && ytReason ? `: ${ytReason}` : ''}
          </div>
        ) : null}

        <div className="notice" style={{ marginTop: 14 }}>
          <b>One-time Google Cloud setup</b> (needed before Connect works):
          <ol style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            <li>Enable <b>YouTube Data API v3</b> in Google Cloud Console.</li>
            <li>Create an <b>OAuth client</b> of type <b>Web application</b>.</li>
            <li>Add this <b>Authorized redirect URI</b> exactly:
              <br /><code>{yt?.redirectUri || '(loading…)'}</code>
            </li>
            <li>Put the client's <b>ID + secret</b> in the “YouTube upload” section below and Save.</li>
            <li>On the OAuth consent screen, add your channel's Google account as a <b>Test user</b>.</li>
          </ol>
        </div>
      </div>

      <form onSubmit={save}>
        {GROUP_ORDER.filter((g) => grouped[g]).map((group) => (
          <div className="card" key={group}>
            <h2>{group}</h2>
            {grouped[group].map(([key, f]) => (
              <div className="field" key={key}>
                <label>
                  {f.label}
                  {f.secret && f.set ? (
                    <span className="tag ok">saved {f.hint}</span>
                  ) : null}
                  {f.source === 'env' ? <span className="tag">from env</span> : null}
                </label>
                <input
                  className="text"
                  type={f.secret ? 'password' : 'text'}
                  value={f.secret ? values[key] || '' : values[key] ?? ''}
                  placeholder={f.secret ? (f.set ? 'leave blank to keep current' : 'not set') : ''}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                />
              </div>
            ))}
          </div>
        ))}

        <div className="row" style={{ position: 'sticky', bottom: 16 }}>
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : '💾 Save settings'}
          </button>
          {message ? <span className="hint">{message}</span> : null}
        </div>
      </form>

      <div className="card">
        <h2>How to get each key</h2>
        <ul className="help">
          <li><b>OpenAI</b> — platform.openai.com → API keys.</li>
          <li><b>Suno wrapper</b> — sign up with Apiframe / MusicAPI / Crazyrouter (Suno has no official API); paste its base URL + key.</li>
          <li><b>Gemini</b> — aistudio.google.com → Get API key (free tier available).</li>
          <li><b>Video worker</b> — deploy the <code>worker/</code> folder to Railway/Render; use its URL + a shared secret you invent.</li>
          <li><b>YouTube</b> — Google Cloud: enable YouTube Data API v3, create a Desktop OAuth client, then run <code>npm run get-refresh-token</code> locally to get the refresh token.</li>
        </ul>
      </div>
    </div>
  );
}
