'use strict';
require('./env');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

/** Create an admin_users row plus its grants. */
async function admin({ email, name, grants = [] }) {
  const { rows } = await db().query(
    'INSERT INTO admin_users (email, display_name) VALUES ($1, $2) RETURNING id, email',
    [email.toLowerCase(), name || email]
  );
  for (const g of grants) {
    await db().query(
      'INSERT INTO admin_grants (admin_user_id, role, business_unit, department_id) VALUES ($1, $2, $3, $4)',
      [rows[0].id, g.role, g.business_unit || null, g.department_id || null]
    );
  }
  return rows[0];
}

/**
 * Sign an admin session token directly (bypasses Microsoft sign-in).
 * `roles` omitted for 'ALL' means everything; for a BU scope it defaults to
 * a plain bu_admin, matching tokens minted before roles existed.
 */
function adminToken({ adminUserId = null, email, unit_scope, roles }) {
  const payload = { admin_user_id: adminUserId, unit_scope, email: email.toLowerCase() };
  if (roles) payload.roles = roles;
  return jwt.sign(payload, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
}

/** Create a candidate user and return a signed candidate token. */
async function candidate({ email, provider = 'password' }) {
  const { rows } = await db().query(
    `INSERT INTO users (email, full_name, auth_provider, auth_subject)
     VALUES ($1, $2, $3, $4) RETURNING id, email`,
    [email.toLowerCase(), email.split('@')[0], provider, provider === 'password' ? null : uniq()]
  );
  const token = jwt.sign({ sub: rows[0].id, email: rows[0].email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { ...rows[0], token };
}

/** Create a hired application for `email` (creates the candidate if needed). */
async function hiredApplication({ email, business_unit = 'Land', name = 'Test Employee', position = 'Engineer', userId }) {
  let uid = userId;
  if (!uid) {
    const existing = await db().query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    uid = existing.rows[0] ? existing.rows[0].id : (await candidate({ email })).id;
  }
  const { rows } = await db().query(
    `INSERT INTO applications (user_id, reference_no, status, business_unit, name_nric, email, position_applying)
     VALUES ($1, $2, 'hired', $3, $4, $5, $6) RETURNING *`,
    [uid, `WCT-T-${uniq()}`, business_unit, name, email.toLowerCase(), position]
  );
  return rows[0];
}

const randomToken = () => crypto.randomBytes(32).toString('hex');

module.exports = { admin, adminToken, candidate, hiredApplication, uniq, randomToken };
