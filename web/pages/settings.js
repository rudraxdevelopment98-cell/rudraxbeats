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

export default function Settings() {
  const router = useRouter();
  const [fields, setFields] = useState(null);
  const [values, setValues] = useState({}); // key -> new input value
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

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
  }, [load]);

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
