// pages/login.js
// "Sign in with Google" (GSI). The first allowed account to sign in becomes
// the owner; others must be added by the owner in Settings → Access.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Script from 'next/script';

export default function Login() {
  const router = useRouter();
  const [state, setState] = useState('loading'); // loading | nokv | noclient | ready
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState('');
  const [gsiReady, setGsiReady] = useState(false);
  const btnRef = useRef(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (d.authed) return router.replace('/');
        if (!d.kvConfigured) return setState('nokv');
        if (!d.loginConfigured || !d.googleClientId) return setState('noclient');
        setClientId(d.googleClientId);
        setState('ready');
      })
      .catch(() => setState('noclient'));
  }, [router]);

  // Initialise the Google button once both the script and the client id exist.
  useEffect(() => {
    if (state !== 'ready' || !gsiReady || !clientId || !window.google) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: async (response) => {
        setError('');
        try {
          const res = await fetch('/api/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential: response.credential }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Login failed');
          router.replace('/');
        } catch (e) {
          setError(e.message);
        }
      },
    });
    if (btnRef.current) {
      window.google.accounts.id.renderButton(btnRef.current, {
        theme: 'filled_blue',
        size: 'large',
        text: 'signin_with',
        shape: 'pill',
      });
    }
  }, [state, gsiReady, clientId, router]);

  return (
    <div className="auth-wrap">
      <Script src="https://accounts.google.com/gsi/client" onLoad={() => setGsiReady(true)} />
      <div className="card auth-card">
        <h1>🎵 AI Song Engine</h1>

        {state === 'loading' && <p className="sub">Loading…</p>}

        {state === 'nokv' && (
          <div className="notice" style={{ marginTop: 16 }}>
            <b>Attach a Vercel KV store first</b> (Vercel → project → Storage →
            Create → KV), then redeploy and reload. That's the one-time database
            the engine needs.
          </div>
        )}

        {state === 'noclient' && (
          <div className="notice" style={{ marginTop: 16 }}>
            <b>Google login isn't configured yet.</b> Set the{' '}
            <code>GOOGLE_CLIENT_ID</code> environment variable in Vercel to your
            Google OAuth client's ID, then redeploy. (See the README — it's the
            same client you'll use for YouTube.)
          </div>
        )}

        {state === 'ready' && (
          <>
            <p className="sub" style={{ marginBottom: 18 }}>
              Sign in with the Google account allowed to manage this channel.
            </p>
            <div ref={btnRef} />
            {error ? <div className="err" style={{ marginTop: 14 }}>⚠ {error}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}
