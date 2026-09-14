'use strict';

// ============================================================================
// Small DB lookups shared by the Power Automate notification call sites
// (routes/applications.js, routes/admin.js, routes/onboarding.js,
// routes/exitInterview.js). Split out here so each route file doesn't
// reimplement the same two queries.
// ============================================================================

const db = require('../db');

const MANAGER_EMAIL_COLUMN = {
  'E&C': 'manager_email_ec',
  Mall: 'manager_email_mall',
  Land: 'manager_email_land',
};

/**
 * The single business-unit manager notification address, from
 * `manager_settings` (spec §1.5/§2.6 "manager notification settings").
 *
 * NOTE: the original Supabase backend stored this in a generic
 * `system_settings(key, value)` key-value table (keys `manager_email_ec`,
 * `manager_email_mall`, `manager_email_land`); this schema instead uses a
 * dedicated `manager_settings` table with one column per BU (already wired
 * up to GET/PUT /api/admin/settings in routes/admin.js). Functionally
 * equivalent for every call site below — swap this query if the two are
 * ever reconciled onto the original generic-table shape.
 */
async function getManagerEmail(businessUnit) {
  const column = MANAGER_EMAIL_COLUMN[businessUnit];
  if (!column) return '';
  const { rows } = await db.query(
    `SELECT ${column} AS email FROM manager_settings ORDER BY created_at DESC LIMIT 1`
  );
  return (rows[0] && rows[0].email) || '';
}

/** Distinct active bu_admin emails for a business unit (mirrors the original `_get_bu_admin_emails`). */
async function getBuAdminEmails(businessUnit) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.email
       FROM admin_grants g
       JOIN admin_users u ON u.id = g.admin_user_id
      WHERE g.role = 'bu_admin' AND g.business_unit = $1 AND u.is_active = true
      ORDER BY u.email`,
    [businessUnit]
  );
  return rows.map((r) => r.email);
}

module.exports = { getManagerEmail, getBuAdminEmails };
