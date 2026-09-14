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
// Password reset: the reference app used Supabase's built-in magic-link
// email flow. Actually sending email (spec §9.4 "notification emails... not
// present in this client-only repo") is out of scope for this pass — the
// request endpoint below issues a short-lived reset token and logs it
// server-side (TODO: wire to Azure Communication Services / SendGrid) so the
// two-endpoint shape (request -> confirm) is already correct for when
// real email delivery is added.
// ============================================================================

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
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

// In-memory reset-token store as a placeholder until real email delivery
// exists. NOTE: this does not survive a process restart / multi-instance
// deployment — acceptable only because actual email sending (the thing that
// would make this reachable by a real user) is itself still a TODO. Replace
// with a `password_reset_tokens` table once email delivery is wired up.
const resetTokens = new Map(); // token -> { userId, expiresAt }

// POST /api/auth/reset-password/request
router.post('/reset-password/request', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  const { rows } = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  // Always respond 200 regardless of whether the account exists, to avoid
  // leaking account existence via response differences.
  if (rows.length > 0) {
    const token = uuidv4();
    resetTokens.set(token, { userId: rows[0].id, expiresAt: Date.now() + 60 * 60 * 1000 });
    // TODO: send `token` to the user via Azure Communication Services /
    // SendGrid instead of only logging it. Logged here purely so the flow is
    // exercisable in this pass without live email delivery.
    // eslint-disable-next-line no-console
    console.log(`[auth] password reset requested for ${email}; token=${token} (TODO: email this instead of logging)`);
  }

  return res.json({ ok: true });
}));

// POST /api/auth/reset-password/confirm
router.post('/reset-password/confirm', asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  const entry = typeof token === 'string' ? resetTokens.get(token) : null;

  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character',
    });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, entry.userId]);
  resetTokens.delete(token);

  return res.json({ ok: true });
}));

module.exports = router;
