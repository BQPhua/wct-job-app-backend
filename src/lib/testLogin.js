'use strict';

// ============================================================================
// TEMPORARY test sign-in, for the on-prem server while it has no HTTPS
// address yet (Microsoft and Google sign-in only work on https://).
//
// OFF unless the server's env file says otherwise:
//   TEST_LOGIN_ENABLED=1
//   TEST_LOGIN_PASSCODE=<shared passcode, 8+ characters>
//   TEST_LOGIN_UNTIL=2026-11-30        (optional: switches itself off after this date)
//
// With it on, a tester types an email + the shared passcode and is signed in
// as that email, with exactly the access that email has (admin grants are
// still checked, so it never gives anyone more access than Microsoft
// sign-in would). Every use is written to the server log.
// Turn it OFF (remove TEST_LOGIN_ENABLED) before opening the site to the
// internet.
// ============================================================================

const crypto = require('crypto');

function todayMYT() {
  // Malaysia time, yyyy-mm-dd
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function status() {
  const on = process.env.TEST_LOGIN_ENABLED === '1';
  const pass = process.env.TEST_LOGIN_PASSCODE || '';
  const until = /^\d{4}-\d{2}-\d{2}$/.test(process.env.TEST_LOGIN_UNTIL || '') ? process.env.TEST_LOGIN_UNTIL : null;
  const expired = until ? todayMYT() > until : false;
  return { enabled: on && pass.length >= 8 && !expired, until };
}

// Failed attempts per IP (in memory): 10 wrong passcodes in 15 minutes → wait.
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILS = 10;

function ipOf(req) {
  const remote = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const fwd = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || remote || 'unknown';
}

function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Throws an Error with .status when the test sign-in must be refused;
 * returns normally when the passcode is right.
 */
function check(req, passcode, who) {
  const err = (status, message) => Object.assign(new Error(message), { status });
  if (!status().enabled) throw err(404, 'Test sign-in is turned off.');

  const ip = ipOf(req);
  const now = Date.now();
  const f = fails.get(ip);
  if (f && f.resetAt > now && f.count >= MAX_FAILS) {
    throw err(429, 'Too many wrong passcodes. Please wait 15 minutes and try again.');
  }
  if (!passcode || !same(passcode, process.env.TEST_LOGIN_PASSCODE)) {
    const cur = f && f.resetAt > now ? f : { count: 0, resetAt: now + WINDOW };
    cur.count += 1;
    fails.set(ip, cur);
    // eslint-disable-next-line no-console
    console.warn(`[test-login] wrong passcode for ${who} from ${ip}`);
    throw err(401, 'Wrong test passcode.');
  }
  fails.delete(ip);
  // eslint-disable-next-line no-console
  console.log(`[test-login] ${who} signed in from ${ip}`);
}

function _resetForTests() { fails.clear(); }

module.exports = { status, check, _resetForTests };
