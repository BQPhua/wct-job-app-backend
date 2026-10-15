'use strict';

// ============================================================================
// Business units — the managed list in `business_units` (migration 008).
//
// `code` is what every row stores (applications.business_unit, grants,
// offboarding cases...) and what candidate links carry (?bu=Land). `name` is
// what people see ("Property Development"). The three original units kept
// their codes (E&C, Land, Mall) so old data and live links keep working.
// ============================================================================

const db = require('../db');

const COLUMNS = 'code, name, ref_code, pic_email, sort_order, is_active';

/** Every unit, ordered for display. */
async function list({ activeOnly = false, client = db } = {}) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM business_units ${activeOnly ? 'WHERE is_active' : ''} ORDER BY sort_order, name`
  );
  return rows;
}

async function get(code, client = db) {
  if (!code) return null;
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM business_units WHERE code = $1`, [String(code)]);
  return rows[0] || null;
}

/** True when `code` is a unit (an active one, when activeOnly). */
async function isValid(code, { activeOnly = false } = {}) {
  const bu = await get(code);
  return !!bu && (!activeOnly || bu.is_active);
}

/**
 * Find the unit a candidate link means: matches the code or the display name,
 * ignoring case ("?bu=Land", "?bu=property development", "?bu=F%26B").
 */
async function resolve(input) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return null;
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM business_units WHERE lower(code) = $1 OR lower(name) = $1 ORDER BY (lower(code) = $1) DESC LIMIT 1`,
    [v]
  );
  return rows[0] || null;
}

/** code -> display name, for labels in emails and exports. */
async function nameMap() {
  const rows = await list();
  return Object.fromEntries(rows.map((r) => [r.code, r.name]));
}

module.exports = { list, get, isValid, resolve, nameMap };
