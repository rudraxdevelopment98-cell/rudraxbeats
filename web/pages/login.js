// pages/login.js — motion-based Google sign-in screen.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Script from 'next/script';
import { motion } from 'framer-motion';
import { Background } from '../components/ui';

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
        theme: 'filled_black',
        size: 'large',
        text: 'continue_with',
        shape: 'pill',
        width: 280,
      });
    }
  }, [state, gsiReady, clientId, router]);

  return (
    <div className="auth">
      <Background />
      <Script src="https://accounts.google.com/gsi/client" onLoad={() => setGsiReady(true)} />
      <motion.div
        className="card auth-card"
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 220, damping: 22 }}
      >
        <motion.div
          className="logo-lg"
          initial={{ rotate: -12, scale: 0.6 }}
          animate={{ rotate: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.1 }}
        >
          🎵
        </motion.div>
        <h1>AI Song Engine</h1>

        {state === 'loading' && <p>Loading…</p>}

        {state === 'nokv' && (
          <div className="notice" style={{ textAlign: 'left' }}>
            <b>Attach a Vercel KV / Redis store</b> to this project (Storage →
            Create), then redeploy and reload. It's the one-time database the
            engine needs.
          </div>
        )}

        {state === 'noclient' && (
          <div className="notice" style={{ textAlign: 'left' }}>
            <b>Google login isn't configured.</b> Set <code>GOOGLE_CLIENT_ID</code>{' '}
            in Vercel to your OAuth client's ID, then redeploy.
          </div>
        )}

        {state === 'ready' && (
          <>
            <p>Sign in with the Google account for this channel.</p>
            <div className="gbtn-wrap" ref={btnRef} />
            {error ? (
              <motion.div className="err-note" style={{ marginTop: 16 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                ⚠ {error}
              </motion.div>
            ) : null}
          </>
        )}
      </motion.div>
    </div>
  );
}
