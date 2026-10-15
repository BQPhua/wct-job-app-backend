'use strict';

// ============================================================================
// Small DB lookups shared by the Power Automate notification call sites
// (routes/applications.js, routes/admin.js, routes/onboarding.js,
// routes/adminOffboarding.js). Split out here so each route file doesn't
// reimplement the same two queries.
// ============================================================================

const db = require('../db');

/**
 * Who hears about a business unit's events (BU transfer, status change,
 * onboarding completed): the unit's designated PIC from Business Unit
 * Settings (business_units.pic_email, migration 008 — it took over the old
 * per-unit manager_settings addresses), else its HR admins, else the Super
 * Admins, so a notification always reaches someone. Semicolon-separated.
 */
async function getManagerEmail(businessUnit) {
  const { rows } = await db.query('SELECT pic_email FROM business_units WHERE code = $1', [businessUnit]);
  const configured = rows[0] && rows[0].pic_email;
  if (configured) return configured.split(/[;,]\s*/).filter(Boolean).join(';');
  const fallbackEmails = await getBuAdminEmails(businessUnit);
  return fallbackEmails.join(';');
}

/**
 * Distinct active bu_admin emails for a business unit (mirrors the original
 * `_get_bu_admin_emails`).
 *
 * FALLBACK (added 2026-09-17): `admin_grants` enforces
 * `(role = 'super_admin' AND business_unit IS NULL)` — a super_admin grant
 * can never carry a business_unit, so it can never match this query's
 * `business_unit = $1` filter. If a business unit has no dedicated,
 * *active* bu_admin assigned (e.g. E&C in production right now), the query
 * above returns zero rows, `notifyEmails.join(';')` becomes `''`, and the
 * downstream Power Automate "Send an email (V2)" step fails with
 * "Bad Request - To Field cannot be null or empty". Falling back to active
 * super_admin emails whenever no BU-specific admin exists keeps someone in
 * the loop for every business unit, matching what a super_admin — who by
 * definition oversees every BU — would reasonably want to see anyway.
 */
async function getBuAdminEmails(businessUnit) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.email
       FROM admin_grants g
       JOIN admin_users u ON u.id = g.admin_user_id
      WHERE g.role = 'bu_admin' AND g.business_unit = $1 AND u.is_active = true
      ORDER BY u.email`,
    [businessUnit]
  );
  if (rows.length > 0) return rows.map((r) => r.email);

  const fallback = await db.query(
    `SELECT DISTINCT u.email
       FROM admin_grants g
       JOIN admin_users u ON u.id = g.admin_user_id
      WHERE g.role = 'super_admin' AND u.is_active = true
      ORDER BY u.email`
  );
  return fallback.rows.map((r) => r.email);
}

module.exports = { getManagerEmail, getBuAdminEmails };
