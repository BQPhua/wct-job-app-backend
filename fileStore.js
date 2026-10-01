'use strict';

// ============================================================================
// Local-disk file storage for candidate uploads (used when UPLOAD_DIR is set,
// i.e. on our own Ubuntu server instead of Azure Blob Storage).
//
// Files live at  <UPLOAD_DIR>/<folder>/<user id>/<uuid>-<safe name>  and are
// served by GET /api/files/<folder>/<user id>/<file>?exp=..&sig=.. . The link
// is the local twin of the old Azure SAS URL: long-lived, read-only, and only
// valid for that exact file, because `sig` is an HMAC of the path + expiry.
// The link is relative ("/api/files/..."), so it keeps working if the site's
// domain changes, and it is what gets stored in applications.attachments.
// ============================================================================

const crypto = require('crypto');
const path = require('path');

const FOLDERS = ['profile-pictures', 'attachments'];
const LINK_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years, like the old SAS links

function uploadDir() {
  return process.env.UPLOAD_DIR || '';
}
const enabled = () => !!uploadDir();

// A dedicated key derived from the JWT secret, so no new setting is needed
// (FILE_URL_SECRET overrides it if you ever want to rotate links separately).
function key() {
  const base = process.env.FILE_URL_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET (or FILE_URL_SECRET) must be set to sign file links');
  return crypto.createHmac('sha256', base).update('wct-file-links-v1').digest();
}
function sign(fileKey, exp) {
  return crypto.createHmac('sha256', key()).update(`${fileKey}:${exp}`).digest('base64url');
}

/** Signed relative link for "<folder>/<user id>/<file>". `expMs` is for tests. */
function signedUrl(fileKey, expMs = Date.now() + LINK_LIFETIME_MS) {
  const exp = Math.floor(expMs / 1000);
  return `/api/files/${fileKey}?exp=${exp}&sig=${sign(fileKey, exp)}`;
}

function verify(fileKey, exp, sig) {
  if (!/^\d{1,12}$/.test(String(exp || '')) || typeof sig !== 'string' || !sig) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  const want = Buffer.from(sign(fileKey, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
/**
 * Absolute path for a file key, or null if the key isn't
 * "<known folder>/<segment>/<segment>" with plain characters only.
 */
function resolve(fileKey) {
  const parts = String(fileKey).split('/');
  if (parts.length !== 3 || !FOLDERS.includes(parts[0])) return null;
  if (!parts.slice(1).every((p) => SEGMENT.test(p) && !p.includes('..'))) return null;
  const root = path.resolve(uploadDir());
  const full = path.resolve(root, ...parts);
  return full.startsWith(root + path.sep) ? full : null;
}

module.exports = { FOLDERS, enabled, uploadDir, signedUrl, verify, resolve, LINK_LIFETIME_MS };
