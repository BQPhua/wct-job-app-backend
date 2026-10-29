'use strict';

// ============================================================================
// Candidate auth: register / login / reset-password-request / reset-
// password-confirm. Replaces Supabase Auth's email+password path (spec
// §3.1) with our own bcrypt + JWT implementation.
//
// Google + Microsoft OAuth sign-in/sign-up (spec §3.1's other two login-UI
// tabs, alongside email+password above) are implemented below, at
// POST /api/auth/oauth/google and POST /api/auth/oauth/microsoft — see
// src/lib/oauthVerify.js for the actual ID-token verification against each
// provider's public keys. Both reuse the existing, already-configured OAuth
// apps (product owner instruction, 2026-09-11) rather than new ones. The
// JWT-issuing shape here (`issueToken({ id, email })`) is provider-agnostic:
// both OAuth routes resolve/create a `users` row (matched by email, same as
// the reference app's OAuth accounts did) and then call the exact same
// `issueToken` helper as the password flow.
//
// Password reset: the request endpoint emails a one-hour link through the
// generic Power Automate email flow; see "Forgot password" below.
// ============================================================================

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { verifyGoogleIdToken, verifyMicrosoftIdToken } = require('../lib/oauthVerify');

const router = express.Router();

const BCRYPT_ROUNDS = 12;

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Mirrors the reference app's client-side password-strength check (spec
// §3.1: >=8 chars, upper, lower, number, special char) — but enforced
// server-side here, since client-side-only enforcement is not real
// enforcement.
function isStrongPassword(password) {
  if (typeof password !== 'string' || password.length < 8) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^a-zA-Z0-9]/.test(password)) return false;
  return true;
}

// POST /api/auth/register
router.post('/register', asyncHandler(async (req, res) => {
  const { email, password, full_name: fullName } = req.body || {};

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character',
    });
  }

  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, full_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, full_name`,
    [email.toLowerCase(), passwordHash, fullName || null]
  );

  const user = rows[0];
  const token = issueToken(user);
  return res.status(201).json({
    token,
    user: { id: user.id, email: user.email, name: user.full_name || '' },
  });
}));

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { rows } = await db.query(
    'SELECT id, email, password_hash, full_name FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const user = rows[0];
  if (!user.password_hash) {
    // Signed up with Google or Microsoft: there is no password to check.
    return res.status(401).json({ error: 'This account signs in with Google or Microsoft. Use that button, or choose "Forgot password?" to set a password.' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Blacklist gate happens immediately after auth resolves, before any other
  // data loads (spec §1.1 rpc_check_blacklist, §3.1). We check it here too
  // (in addition to the dedicated /api/blacklist-check endpoint) so a
  // blacklisted candidate never even gets a usable token.
  const blacklisted = await db.query(
    'SELECT 1 FROM candidate_blacklist WHERE email = $1 AND is_blacklisted = true',
    [user.email]
  );
  if (blacklisted.rows.length > 0) {
    return res.status(403).json({ error: 'blacklisted' });
  }

  const token = issueToken(user);
  return res.json({
    token,
    user: { id: user.id, email: user.email, name: user.full_name || '' },
  });
}));

// ============================================================================
// Shared OAuth sign-in/sign-up handler (spec §3.1's Google/Microsoft login-UI
// tabs). Both provider routes below do the same three things once the ID
// token is verified: (1) reject blacklisted candidates, exactly like /login;
// (2) find an existing `users` row by email, or create one on first sign-in
// (sign-up and login are the same action for OAuth, as in the reference
// app); (3) issue the same candidate JWT the password flow issues.
//
// Linking is by email, matching how the reference app's Supabase-auth OAuth
// accounts worked. `auth_provider`/`auth_subject` (migration 003) are best-
// effort bookkeeping, not the lookup key — an existing password-created
// account with the same email is treated as the same person signing in a
// different way, and gets linked to their first OAuth subject id rather than
// rejected or duplicated.
// ============================================================================
async function resolveOrCreateOAuthUser({ email, name, subject, provider }) {
  const existing = await db.query(
    'SELECT id, email, full_name FROM users WHERE email = $1',
    [email]
  );
  if (existing.rows.length > 0) {
    const user = existing.rows[0];
    // Best-effort link/refresh of provider bookkeeping; never blocks sign-in
    // if it fails for some reason.
    await db.query(
      `UPDATE users SET auth_provider = $1, auth_subject = COALESCE(auth_subject, $2)
       WHERE id = $3`,
      [provider, subject, user.id]
    );
    return user;
  }

  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, full_name, auth_provider, auth_subject)
     VALUES ($1, NULL, $2, $3, $4)
     RETURNING id, email, full_name`,
    [email, name || null, provider, subject]
  );
  return rows[0];
}

async function handleOAuthSignIn(res, identity, provider) {
  const blacklisted = await db.query(
    'SELECT 1 FROM candidate_blacklist WHERE email = $1 AND is_blacklisted = true',
    [identity.email]
  );
  if (blacklisted.rows.length > 0) {
    return res.status(403).json({ error: 'blacklisted' });
  }

  const user = await resolveOrCreateOAuthUser({
    email: identity.email,
    name: identity.name,
    subject: identity.subject,
    provider,
  });

  const token = issueToken(user);
  return res.json({
    token,
    user: { id: user.id, email: user.email, name: user.full_name || '' },
  });
}

// POST /api/auth/oauth/google  { id_token }
// `id_token` comes from Google Identity Services on the frontend
// (google.accounts.id.initialize / renderButton, or the One Tap prompt) —
// this endpoint verifies it server-side rather than trusting the frontend.
router.post('/oauth/google', asyncHandler(async (req, res) => {
  const { id_token: idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'id_token is required' });

  let identity;
  try {
    identity = await verifyGoogleIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: `Invalid Google sign-in: ${err.message}` });
  }

  return handleOAuthSignIn(res, identity, 'google');
}));

// POST /api/auth/oauth/microsoft  { id_token }
// `id_token` comes from MSAL.js on the frontend (loginPopup/loginRedirect
// against the same Azure app registration used by the reference app) — this
// endpoint verifies it server-side rather than trusting the frontend.
router.post('/oauth/microsoft', asyncHandler(async (req, res) => {
  const { id_token: idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'id_token is required' });

  let identity;
  try {
    identity = await verifyMicrosoftIdToken(idToken, process.env.MS_CLIENT_ID);
  } catch (err) {
    return res.status(401).json({ error: `Invalid Microsoft sign-in: ${err.message}` });
  }

  return handleOAuthSignIn(res, identity, 'microsoft');
}));

// ----------------------------------------------------------------------------
// Forgot password (stakeholder feedback, 30 Oct 2026: the reset email never
// arrived because it was never sent). The request emails a one-hour link
// (reset-password.html?token=...) through the generic email flow; only a
// hash of the token is stored (password_reset_tokens, migration 010), so the
// link survives a restart and a database leak doesn't reveal live links.
// ----------------------------------------------------------------------------
const crypto = require('crypto');
const { simpleEmail } = require('../lib/candidateEmails');

const RESET_TTL_MS = 60 * 60 * 1000;
const RESET_RESEND_GAP_S = 60; // at most one email a minute per account
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const frontendBase = () => (process.env.FRONTEND_BASE_URL || 'https://hrforms.wct.my').replace(/\/+$/, '');

// POST /api/auth/reset-password/request
router.post('/reset-password/request', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  // Same answer whether or not the account exists, so this can't be used to
  // find out who has an account.
  const done = () => res.json({ ok: true });

  const { rows } = await db.query('SELECT id, email, full_name FROM users WHERE email = $1', [email.toLowerCase()]);
  if (!rows.length) return done();
  const user = rows[0];

  try {
    const recent = await db.query(
      `SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND created_at > now() - make_interval(secs => $2)`,
      [user.id, RESET_RESEND_GAP_S]
    );
    if (recent.rows.length) return done();
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1 AND (used_at IS NOT NULL OR expires_at < now())', [user.id]);
    await db.query('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [hashToken(token), user.id, new Date(Date.now() + RESET_TTL_MS)]);
    const sent = await simpleEmail({
      area: 'Careers',
      eyebrow: 'Password Reset',
      to: [user.email],
      subject: 'Reset your password',
      heading: 'Reset your password',
      intro: `Dear ${String(user.full_name || 'Candidate').replace(/[<>&"]/g, '')},<br><br>We received a request to reset the password for your WCT Careers account. Use the button below to choose a new password. The link works once and expires in 1 hour.`,
      rows: [['Account', user.email]],
      button: { label: 'Choose a new password', href: `${frontendBase()}/reset-password.html?token=${token}` },
      note: "Didn't ask for this? You can ignore this email; your password stays the same.",
      eventType: 'password_reset',
      ref: '',
    });
    if (!sent.ok) {
      // eslint-disable-next-line no-console
      console.error(`[auth] password reset email for ${user.email} not sent (${sent.skipped || `HTTP ${sent.status}`})`);
      return res.status(503).json({ error: 'We could not send the reset email just now. Please try again in a few minutes.' });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth] password reset request failed:', err.message);
    return res.status(503).json({ error: 'We could not send the reset email just now. Please try again in a few minutes.' });
  }
  return done();
}));

// POST /api/auth/reset-password/confirm
router.post('/reset-password/confirm', asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'This reset link is invalid. Please request a new one.' });
  if (!isStrongPassword(password)) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character',
    });
  }
  const { rows } = await db.query(
    'SELECT user_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
    [hashToken(token)]
  );
  if (!rows.length) return res.status(400).json({ error: 'This reset link has expired or was already used. Please request a new one.' });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.withTransaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, rows[0].user_id]);
    await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [rows[0].user_id]);
  });
  return res.json({ ok: true });
}));

module.exports = router;
