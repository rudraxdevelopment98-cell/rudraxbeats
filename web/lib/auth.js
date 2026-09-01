// lib/auth.js
// Minimal single-admin auth for the dashboard so the Settings page (which
// holds API keys) isn't world-readable.
//
//  - First visit with no password set  -> "setup" mode: the user creates one.
//  - Password is stored as a scrypt hash + salt in KV (never in plaintext).
//  - Login issues an HMAC-signed, httpOnly session cookie.
//  - A random session-signing secret is generated on setup and kept in KV.
//
// This is deliberately lightweight (one admin, no user table) - appropriate
// for a personal automation dashboard.

import crypto from 'crypto';
import { kvStore } from './db.js';

const PW_HASH_KEY = 'auth:passwordHash';
const PW_SALT_KEY = 'auth:passwordSalt';
const SECRET_KEY = 'auth:sessionSecret';
const COOKIE_NAME = 'ase_session';
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

const isProd = process.env.NODE_ENV === 'production';

function scryptHash(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

async function getSessionSecret() {
  let s = await kvStore.get(SECRET_KEY);
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    await kvStore.set(SECRET_KEY, s);
  }
  return s;
}

/** @returns {Promise<{setup: boolean}>} setup=true means a password exists. */
export async function getAuthState() {
  const hash = await kvStore.get(PW_HASH_KEY);
  return { setup: Boolean(hash) };
}

/** Create the initial admin password. Throws if one already exists. */
export async function setupPassword(password) {
  if (!password || String(password).length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  const { setup } = await getAuthState();
  if (setup) throw new Error('Password already set.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = scryptHash(password, salt);
  await kvStore.set(PW_SALT_KEY, salt);
  await kvStore.set(PW_HASH_KEY, hash);
  await getSessionSecret(); // ensure a signing secret exists
  return true;
}

export async function verifyPassword(password) {
  const [hash, salt] = await Promise.all([
    kvStore.get(PW_HASH_KEY),
    kvStore.get(PW_SALT_KEY),
  ]);
  if (!hash || !salt) return false;
  const attempt = scryptHash(password || '', salt);
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- session tokens --------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
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

export async function issueSession(res) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const token = await signToken({ exp });
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSession(res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** @returns {Promise<boolean>} true if the request carries a valid session. */
export async function isAuthed(req) {
  const cookies = parseCookies(req);
  const payload = await verifyToken(cookies[COOKIE_NAME]);
  return Boolean(payload);
}

/**
 * Guard for API routes. Returns true if authed; otherwise writes 401 and
 * returns false (caller should `return`).
 */
export async function requireAuth(req, res) {
  if (await isAuthed(req)) return true;
  res.status(401).json({ error: 'Not authenticated' });
  return false;
}
