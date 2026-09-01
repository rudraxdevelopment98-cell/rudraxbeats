// pages/login.js
// Handles first-run password setup AND normal login, based on /api/auth/me.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

export default function Login() {
  const router = useRouter();
  const [mode, setMode] = useState('loading'); // loading | setup | login | nokv
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (d.authed) return router.replace('/');
        if (!d.kvConfigured) return setMode('nokv');
        setMode(d.setup ? 'login' : 'setup');
      })
      .catch(() => setMode('login'));
  }, [router]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (mode === 'setup' && password !== confirm) {
      return setError('Passwords do not match.');
    }
    setBusy(true);
    try {
      const endpoint = mode === 'setup' ? '/api/auth/setup' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      router.replace('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'loading') {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">Loading…</div>
      </div>
    );
  }

  if (mode === 'nokv') {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">
          <h1>🎵 AI Song Engine</h1>
          <div className="notice" style={{ marginTop: 16 }}>
            <b>Almost there.</b> Attach a <b>Vercel KV</b> store to this project
            first (Vercel → your project → <b>Storage</b> → <b>Create</b> →{' '}
            <b>KV</b>), then redeploy and reload this page. That's the one-time
            database the engine needs to store your settings and job history.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <h1>🎵 AI Song Engine</h1>
        <p className="sub" style={{ marginBottom: 20 }}>
          {mode === 'setup'
            ? 'Create an admin password to protect your dashboard & API keys.'
            : 'Enter your admin password.'}
        </p>

        <label>Password</label>
        <input
          type="password"
          className="text"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === 'setup' ? 'at least 6 characters' : ''}
        />

        {mode === 'setup' && (
          <>
            <label>Confirm password</label>
            <input
              type="password"
              className="text"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </>
        )}

        {error ? <div className="err" style={{ marginTop: 12 }}>⚠ {error}</div> : null}

        <button type="submit" disabled={busy} style={{ marginTop: 18, width: '100%' }}>
          {busy ? 'Please wait…' : mode === 'setup' ? 'Create password & enter' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
