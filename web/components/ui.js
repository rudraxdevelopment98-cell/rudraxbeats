// components/ui.js
// Shared, motion-enabled UI primitives for the dashboard.
import { motion } from 'framer-motion';
import { useRouter } from 'next/router';
import Link from 'next/link';

// ---- animation variants ----
export const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 260, damping: 26 } },
};
export const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};
export const press = { whileHover: { scale: 1.03 }, whileTap: { scale: 0.97 } };

// A card that animates in on mount.
export function Card({ children, className = '', delay = 0, ...rest }) {
  return (
    <motion.div
      className={`card ${className}`}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 240, damping: 24, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export function MotionButton({ children, className = 'btn', ...rest }) {
  return (
    <motion.button className={className} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.96 }} {...rest}>
      {children}
    </motion.button>
  );
}

// The animated aurora background + subtle grain.
export function Background() {
  return (
    <>
      <div className="bg" />
      <div className="grain" />
    </>
  );
}

export function Brand({ small }) {
  return (
    <div className="brand">
      <span className="logo">🎵</span>
      {!small && (
        <span>
          AI Song <span className="grad-text">Engine</span>
        </span>
      )}
    </div>
  );
}

export function Nav({ user }) {
  const router = useRouter();
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  };
  const onSettings = router.pathname === '/settings';
  return (
    <motion.nav
      className="nav"
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <Link href="/">
        <Brand />
      </Link>
      <div className="nav-actions">
        {user?.email && (
          <span className="chip">
            {user.picture ? <img src={user.picture} alt="" /> : '👤'}
            <span className="hide-sm">{user.email}</span>
          </span>
        )}
        <Link href={onSettings ? '/' : '/settings'} className="chip" style={{ fontWeight: 600, color: 'var(--text)' }}>
          {onSettings ? '← Dashboard' : '⚙️ Settings'}
        </Link>
        <MotionButton className="btn ghost" onClick={logout} style={{ padding: '7px 14px' }}>
          Log out
        </MotionButton>
      </div>
    </motion.nav>
  );
}

export function Toggle({ on, onClick, disabled }) {
  return (
    <div className={`switch ${on ? 'on' : ''}`} onClick={disabled ? undefined : onClick} role="switch" aria-checked={on}>
      <motion.div className="knob" layout transition={{ type: 'spring', stiffness: 700, damping: 34 }} />
    </div>
  );
}

// Full-page centered loader.
export function Loader() {
  return (
    <div className="auth">
      <Background />
      <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}>
        <div style={{ width: 34, height: 34, borderRadius: '50%', border: '3px solid rgba(255,255,255,.15)', borderTopColor: 'var(--violet)' }} />
      </motion.div>
    </div>
  );
}
