// lib/auth.js
// Google-based auth for the dashboard + an email allowlist for sharing access.
//
//  - Login is "Sign in with Google" (GSI). The browser gets an ID token (JWT),
//    the server verifies it against GOOGLE_CLIENT_ID (public, an env var so it
//    exists before anyone logs in), and issues an HMAC-signed session cookie.
//  - Access control: the FIRST person to sign in becomes the owner (stored in
//    KV). The owner can add/remove other Google emails from the Settings page.
//    Only the owner + allowed emails may log in.
//
// No passwords. The session-signing secret lives in KV.

import crypto from 'crypto';
import { google } from 'googleapis';
import { kvStore } from './db.js';
import { DEFAULT_GOOGLE_CLIENT_ID } from './googleClient.js';

const SECRET_KEY = 'auth:sessionSecret';
const ACCESS_KEY = 'access';
const COOKIE_NAME = 'ase_session';
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days
const isProd = process.env.NODE_ENV === 'production';

export function getGoogleClientId() {
  return process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
}
export function loginConfigured() {
  return Boolean(getGoogleClientId());
}

const norm = (e) => String(e || '').trim().toLowerCase();

async function getSessionSecret() {
  let s = await kvStore.get(SECRET_KEY);
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    await kvStore.set(SECRET_KEY, s);
  }
  return s;
}

// --- access list -----------------------------------------------------------

export async function getAccess() {
  const a = await kvStore.get(ACCESS_KEY);
  return {
    ownerEmail: a?.ownerEmail || null,
    allowed: Array.isArray(a?.allowed) ? a.allowed : [],
  };
}

async function saveAccess(a) {
  await kvStore.set(ACCESS_KEY, a);
  return a;
}

/** First login claims ownership. */
export async function ensureOwner(email) {
  const a = await getAccess();
  if (!a.ownerEmail) {
    a.ownerEmail = norm(email);
    await saveAccess(a);
  }
  return getAccess();
}

export async function isAllowed(email) {
  const e = norm(email);
  const a = await getAccess();
  if (!a.ownerEmail) return true; // nobody yet -> first login allowed
  return e === a.ownerEmail || a.allowed.map(norm).includes(e);
}

export async function isOwner(email) {
  const a = await getAccess();
  return Boolean(a.ownerEmail) && norm(email) === a.ownerEmail;
}

export async function addAllowed(email) {
  const e = norm(email);
  if (!e || !e.includes('@')) throw new Error('Enter a valid email.');
  const a = await getAccess();
  if (e !== a.ownerEmail && !a.allowed.map(norm).includes(e)) a.allowed.push(e);
  await saveAccess(a);
  return getAccess();
}

export async function removeAllowed(email) {
  const e = norm(email);
  const a = await getAccess();
  a.allowed = a.allowed.filter((x) => norm(x) !== e);
  await saveAccess(a);
  return getAccess();
}

// --- Google ID token verification ------------------------------------------

export async function verifyGoogleIdToken(idToken) {
  const cid = getGoogleClientId();
  if (!cid) throw new Error('GOOGLE_CLIENT_ID is not set on the server.');
  const client = new google.auth.OAuth2(cid);
  const ticket = await client.verifyIdToken({ idToken, audience: cid });
  const p = ticket.getPayload();
  if (!p || !p.email) throw new Error('Google token had no email.');
  if (!p.email_verified) throw new Error('This Google email is not verified.');
  return { email: p.email, name: p.name || p.email, picture: p.picture || null };
}

// --- session tokens --------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

async function signToken(payload) {
  const secret = await getSessionSecret();
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

async function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const secret = await getSessionSecret();
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

export async function issueSession(res, user) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const token = await signToken({
    exp,
    email: norm(user.email),
    name: user.name || '',
    picture: user.picture || '',
  });
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSession(res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** @returns {Promise<{email,name,picture,exp}|null>} */
export async function getSession(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

export async function isAuthed(req) {
  return Boolean(await getSession(req));
}

/** Returns the session (truthy) or writes 401 and returns null. */
export async function requireAuth(req, res) {
  const s = await getSession(req);
  if (s) return s;
  res.status(401).json({ error: 'Not authenticated' });
  return null;
}

/** Returns the session if the caller is the owner, else writes 401/403. */
export async function requireOwner(req, res) {
  const s = await requireAuth(req, res);
  if (!s) return null;
  if (!(await isOwner(s.email))) {
    res.status(403).json({ error: 'Owner only' });
    return null;
  }
  return s;
}
