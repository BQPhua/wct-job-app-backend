'use strict';

// ============================================================================
// Auth middleware.
//
// Two independent verification paths, deliberately using two different JWT
// secrets (JWT_SECRET vs ADMIN_JWT_SECRET) so a candidate token can never be
// replayed as an admin token or vice versa even if someone mixes them up.
//
// ---- Candidate auth ----
// Verifies a JWT issued at login (src/routes/auth.js) and attaches
// `req.user = { id, email }`. This directly replaces Supabase Auth's
// `auth.uid()` + session JWT (spec §3.1) — every "my own records" endpoint
// filters by `req.user.id` exactly like the RPCs filtered by `auth.uid()`.
//
// ---- Admin auth ----
// Spec §1.5/§3.2 describes an *opaque* server-issued session token
// (`admin_sessions.token`), looked up in the DB on every call, carrying
// `{ admin_user_id, unit_scope }`. Here we instead issue a signed JWT
// carrying the same two claims (`admin_user_id`, `unit_scope`) and verify it
// statelessly (no DB lookup per request).
//
// DELIBERATE SIMPLIFICATION, documented per the task brief: this trades the
// original "opaque token + DB lookup" model (which allows instant server-side
// revocation of a single live session, and doesn't require clients to hold a
// secret-signed blob) for a signed-claim model (stateless, no DB round trip
// to verify, but a token can't be revoked before its own expiry once issued).
// The *scoping semantics* the spec calls load-bearing — one business unit
// (or 'ALL' for a super admin) chosen once per session and enforced on every
// subsequent request — are preserved exactly; only the verification
// mechanism differs. If instant revocation (e.g. for `rpc_admin_set_admin_active`
// deactivating someone mid-session) becomes a hard requirement, swap this
// middleware for one that looks up `admin_sessions`-equivalent state per
// request — the route-handler code above this middleware doesn't need to
// change, since it only ever reads `req.admin.{adminUserId,unitScope}`.
// ============================================================================

const jwt = require('jsonwebtoken');

function requireCandidateAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdminAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing admin session token' });
  }
  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.admin = {
      adminUserId: payload.admin_user_id,
      unitScope: payload.unit_scope, // 'ALL' or one of 'E&C' | 'Land' | 'Mall'
      email: payload.email,
    };
    return next();
  } catch (err) {
    // Client-side auto-logout (see spec §1.5/§3.2) keys off "expired"/
    // "Session" substrings in the error message — preserve that contract.
    return res.status(401).json({ error: 'Admin session expired or invalid' });
  }
}

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

module.exports = { requireCandidateAuth, requireAdminAuth };
