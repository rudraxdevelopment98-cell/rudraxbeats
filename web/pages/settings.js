// pages/settings.js — motion-based settings: access, YouTube, and API keys.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { motion, AnimatePresence } from 'framer-motion';
import { Background, Nav, Card, MotionButton, Loader, fadeUp, stagger } from '../components/ui';

const GROUP_ORDER = ['Lyrics (OpenAI)', 'Song (Suno)', 'Thumbnail (Gemini)', 'Video worker', 'YouTube upload', 'Playlist & content', 'Storage (Google Drive)'];
const GROUP_ICON = {
  'Lyrics (OpenAI)': '✍️',
  'Song (Suno)': '🎵',
  'Thumbnail (Gemini)': '🖼️',
  'Video worker': '🎬',
  'YouTube upload': '⬆️',
  'Playlist & content': '🎼',
  'Storage (Google Drive)': '💾',
};
const GROUP_TEST = {
  'Lyrics (OpenAI)': 'openai',
  'Song (Suno)': 'suno',
  'Thumbnail (Gemini)': 'gemini',
  'Video worker': 'worker',
};
const YT_MSG = {
  connected: { ok: true, text: '✅ YouTube channel connected.' },
  norefresh: { ok: false, text: 'Google returned no refresh token — revoke at myaccount.google.com/permissions and reconnect.' },
  error: { ok: false, text: '⚠ Could not connect' },
};

export default function Settings() {
  const router = useRouter();
  const [fields, setFields] = useState(null);
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [yt, setYt] = useState(null);
  const [me, setMe] = useState(null);
  const [access, setAccess] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [tests, setTests] = useState({}); // target -> { loading, ok, message }

  const runTest = async (target) => {
    setTests((t) => ({ ...t, [target]: { loading: true } }));
    try {
      const r = await fetch(`/api/test?target=${target}`);
      const d = await r.json();
      setTests((t) => ({ ...t, [target]: { ok: d.ok, message: d.message || (d.ok ? 'OK' : 'Failed') } }));
    } catch (e) {
      setTests((t) => ({ ...t, [target]: { ok: false, message: e.message } }));
    }
  };

  const load = useCallback(async () => {
    const res = await fetch('/api/config');
    if (res.status === 401) return router.replace('/login');
    const data = await res.json();
    setFields(data.fields);
    const init = {};
    for (const [k, f] of Object.entries(data.fields)) if (!f.secret) init[k] = f.value ?? '';
    setValues(init);
  }, [router]);

  const loadYt = useCallback(async () => {
    try { const r = await fetch('/api/youtube/status'); if (r.ok) setYt(await r.json()); } catch (_) {}
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const d = await (await fetch('/api/auth/me')).json();
      setMe(d);
      if (d.isOwner) { const a = await fetch('/api/access'); if (a.ok) setAccess(await a.json()); }
    } catch (_) {}
  }, []);

  useEffect(() => { load(); loadYt(); loadMe(); }, [load, loadYt, loadMe]);

  const changeAccess = async (action, email) => {
    const res = await fetch('/api/access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, email }),
    });
    const data = await res.json();
    if (res.ok) { setAccess(data); setNewEmail(''); } else setMessage(`Access error: ${data.error}`);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setMessage('');
    try {
      const patch = {};
      for (const [k, f] of Object.entries(fields)) {
        const v = values[k];
        if (f.secret) { if (v && v.trim() !== '') patch[k] = v; }
        else patch[k] = v ?? '';
      }
      const res = await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setFields(data.fields);
      setValues((prev) => { const n = { ...prev }; for (const [k, f] of Object.entries(data.fields)) if (f.secret) n[k] = ''; return n; });
      setMessage('Saved ✓');
    } catch (err) { setMessage(`Error: ${err.message}`); } finally { setSaving(false); }
  };

  if (!fields) return <Loader />;

  const grouped = {};
  for (const [k, f] of Object.entries(fields)) (grouped[f.group] = grouped[f.group] || []).push([k, f]);

  const ytParam = router.query.youtube;
  const ytMsg = ytParam ? YT_MSG[ytParam] : null;
  const origin = yt?.redirectUri ? new URL(yt.redirectUri).origin : '';

  return (
    <>
      <Background />
      <Nav user={me?.user} />
      <div className="shell">
        <Card className="hero" delay={0.02} style={{ marginBottom: 20 }}>
          <div className="eyebrow">CONFIGURATION</div>
          <h1 style={{ fontSize: 24 }}>Settings</h1>
          <p style={{ margin: 0 }}>Keys are stored in your database, never in code. Secrets stay masked.</p>
        </Card>

        {/* ACCESS */}
        {me?.isOwner && access && (
          <Card delay={0.06}>
            <div className="card-title">👥 Access — who can log in</div>
            <div className="field">
              <label>Owner</label>
              <div className="job-meta" style={{ fontSize: 13 }}>{access.ownerEmail} (you)</div>
            </div>
            <label style={{ fontSize: 13, fontWeight: 500 }}>Allowed Google emails</label>
            {access.allowed.length === 0 ? (
              <div className="empty" style={{ padding: 16, marginTop: 8 }}>No one else yet.</div>
            ) : (
              <motion.div variants={stagger} initial="hidden" animate="show" style={{ marginTop: 8 }}>
                <AnimatePresence>
                  {access.allowed.map((e) => (
                    <motion.div className="job" key={e} variants={fadeUp} exit={{ opacity: 0, x: -10 }}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span>{e}</span>
                      <MotionButton className="btn danger" style={{ padding: '6px 12px' }} onClick={() => changeAccess('remove', e)}>Remove</MotionButton>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </motion.div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <input className="input" style={{ flex: 1 }} type="email" placeholder="person@gmail.com"
                value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
              <MotionButton className="btn" onClick={() => changeAccess('add', newEmail)}>Add</MotionButton>
            </div>
            <div className="hint">Added people sign in with their own Google account — nothing to share.</div>
          </Card>
        )}

        {/* YOUTUBE */}
        <Card delay={0.1}>
          <div className="card-title">🔗 Connect YouTube channel</div>
          {yt && yt.connected ? (
            <div className="row">
              {yt.channel?.thumbnail ? <img src={yt.channel.thumbnail} alt="" style={{ width: 44, height: 44, borderRadius: '50%' }} /> : null}
              <div>
                <div style={{ fontWeight: 600 }}>Connected as {yt.channel?.title}</div>
                <div className="job-meta">Uploads go to this channel.</div>
              </div>
              <span className="spacer" />
              <a className="btn ghost" href="/api/oauth/youtube/start" style={{ padding: '8px 14px' }}>Change</a>
              <MotionButton className="btn danger" onClick={async () => { await fetch('/api/youtube/disconnect', { method: 'POST' }); loadYt(); }}>Disconnect</MotionButton>
            </div>
          ) : (
            <>
              <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 0 }}>
                Click connect, then pick the Google account that owns your channel. The token saves automatically.
              </p>
              <motion.a className="btn pink lg" href="/api/oauth/youtube/start" whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} style={{ display: 'inline-flex' }}>
                ▶ Connect YouTube channel
              </motion.a>
            </>
          )}
          {ytMsg && (
            <div className={ytMsg.ok ? 'ok-note' : 'notice'} style={{ marginTop: 14 }}>
              {ytMsg.text}{ytParam === 'error' && router.query.reason ? `: ${router.query.reason}` : ''}
            </div>
          )}
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 13 }}>One-time Google Cloud setup ▾</summary>
            <div className="notice" style={{ marginTop: 10 }}>
              <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                <li>Enable <b>YouTube Data API v3</b>.</li>
                <li>Create a <b>Web application</b> OAuth client.</li>
                <li><b>Authorized JavaScript origins</b>: <code>{origin || '(loading…)'}</code></li>
                <li><b>Authorized redirect URIs</b>: <code>{yt?.redirectUri || '(loading…)'}</code></li>
                <li>Client <b>ID</b> → <code>GOOGLE_CLIENT_ID</code> env (login) &amp; the field below (upload); paste the <b>secret</b> below.</li>
                <li>Add each person as a <b>Test user</b> on the consent screen.</li>
              </ol>
            </div>
          </details>
        </Card>

        {/* API KEY GROUPS */}
        <form onSubmit={save}>
          {GROUP_ORDER.filter((g) => grouped[g]).map((group, i) => (
            <Card key={group} delay={0.14 + i * 0.04}>
              <div className="card-title" style={{ justifyContent: 'space-between' }}>
                <span>{GROUP_ICON[group]} {group}</span>
                {GROUP_TEST[group] && (
                  <MotionButton
                    type="button"
                    className="btn ghost"
                    style={{ padding: '5px 12px', fontSize: 12, textTransform: 'none', letterSpacing: 0 }}
                    onClick={() => runTest(GROUP_TEST[group])}
                    disabled={tests[GROUP_TEST[group]]?.loading}
                  >
                    {tests[GROUP_TEST[group]]?.loading ? <span className="spin" /> : '🧪 Test'}
                  </MotionButton>
                )}
              </div>
              {GROUP_TEST[group] && tests[GROUP_TEST[group]] && !tests[GROUP_TEST[group]].loading && (
                <div className={tests[GROUP_TEST[group]].ok ? 'ok-note' : 'notice'} style={{ marginBottom: 14 }}>
                  {tests[GROUP_TEST[group]].ok ? '✓ ' : '✗ '}{tests[GROUP_TEST[group]].message}
                </div>
              )}
              {grouped[group].map(([key, f]) => (
                <div className="field" key={key}>
                  <label>
                    {f.label}
                    {f.secret && f.set ? <span className="tag ok">saved {f.hint}</span> : null}
                    {f.source === 'env' ? <span className="tag">from env</span> : null}
                    {f.source === 'default' && !f.secret ? <span className="tag">default</span> : null}
                  </label>
                  <input
                    className="input"
                    type={f.secret ? 'password' : 'text'}
                    value={f.secret ? values[key] || '' : values[key] ?? ''}
                    placeholder={f.secret ? (f.set ? 'leave blank to keep current' : 'not set') : ''}
                    onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                  />
                </div>
              ))}
            </Card>
          ))}

          <motion.div
            className="row"
            style={{ position: 'sticky', bottom: 16, marginTop: 10, background: 'rgba(10,11,18,.7)', backdropFilter: 'blur(10px)', padding: 12, borderRadius: 14, border: '1px solid var(--border)' }}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
          >
            <MotionButton className="btn lg" type="submit" disabled={saving}>
              {saving ? <><span className="spin" /> Saving…</> : '💾 Save settings'}
            </MotionButton>
            <AnimatePresence>
              {message && (
                <motion.span className="hint" style={{ margin: 0 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  {message}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        </form>
      </div>
    </>
  );
}
