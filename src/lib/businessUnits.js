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

const COLUMNS = 'code, name, ref_code, pic_email, sort_order, is_active, merged_into';

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
  const unit = rows[0] || null;
  // A unit merged into another (REIT -> Mall, migration 009): old links
  // open the unit it was merged into.
  if (unit && unit.merged_into && unit.merged_into !== unit.code) return (await get(unit.merged_into)) || unit;
  return unit;
}

/**
 * Active units for candidate pages, each with the codes/names of units that
 * were merged into it (`aliases`), so old ?bu= links still resolve.
 */
async function publicList() {
  const all = await list();
  return all.filter((u) => u.is_active).map((u) => ({
    code: u.code, name: u.name, ref_code: u.ref_code,
    aliases: all.filter((m) => m.merged_into === u.code).flatMap((m) => [m.code, m.name]),
  }));
}

/** code -> display name, for labels in emails and exports. */
async function nameMap() {
  const rows = await list();
  return Object.fromEntries(rows.map((r) => [r.code, r.name]));
}

module.exports = { list, get, isValid, resolve, publicList, nameMap };
