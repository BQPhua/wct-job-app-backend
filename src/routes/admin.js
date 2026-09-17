'use strict';

// ============================================================================
// Admin (HR) endpoints (spec §1.5, §5). Every route below (except the
// auth/session ones) is mounted behind `requireAdminAuth` and enforces the
// BU-scoping rule: a bu_admin's queries are ALWAYS filtered to their own
// `business_unit` regardless of any requested filter value; only
// `unit_scope === 'ALL'` (super admin) can see/filter across all business
// units. See `effectiveBusinessUnitFilter` below — every list/search/stat/
// export query in this file goes through it rather than trusting a raw
// query param.
// ============================================================================

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireAdminAuth } = require('../middleware/auth');
const { buildPatchUpdate } = require('../lib/patchMerge');
const { notify, sanitizeNotificationPayload } = require('../lib/powerAutomate');
const { getManagerEmail } = require('../lib/notificationHelpers');
const { verifyMicrosoftIdToken } = require('../lib/oauthVerify');

const router = express.Router();

const VALID_BUSINESS_UNITS = ['E&C', 'Land', 'Mall'];

// Human-readable label for a role, for use in notification email bodies
// (e.g. Power Automate's "grant added" / "grant revoked" / "reactivated"
// templates) — the raw `role`/`business_unit` DB values are also sent
// alongside this in every payload below, in case the template would rather
// compose its own wording.
function formatRoleLabel(role, businessUnit) {
  if (role === 'super_admin') return 'Super Admin';
  if (role === 'bu_admin') return `BU Admin (${businessUnit || 'unassigned'})`;
  return role || '';
}
// Statuses selectable via the generic status-setter (spec §6.4) — NOT
// including 'offboarding', which has its own dedicated endpoint with side
// effects (creating the exit_interviews row + notification).
const GENERIC_STATUS_OPTIONS = ['shortlisted', 'kiv', 'hired', 'rejected', 'blacklisted'];
const ALL_KNOWN_STATUSES = [
  'draft', 'submitted', 'under_review', 'shortlisted', 'interview_scheduled',
  'offer_sent', 'withdrawn', 'kiv', 'hired', 'offboarding', 'rejected', 'blacklisted',
];

// Base URL of the deployed candidate/admin frontend, used to build the deep
// links embedded in Power Automate notification payloads (the original app's
// functions hardcoded its GitHub Pages URL, e.g.
// 'https://bqphua.github.io/job-app'; this points at wherever the migrated
// frontend ends up deployed — Azure Static Web Apps).
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://bqphua.github.io/job-app';

function isSuperAdmin(admin) {
  return admin.unitScope === 'ALL';
}

/**
 * Resolve the BU filter that must actually be applied to a query, enforcing
 * the scoping rule described in the module header. Returns `null` to mean
 * "no BU filter" (only possible for a super admin who also didn't request
 * one) or a specific BU string to filter on.
 */
function effectiveBusinessUnitFilter(admin, requestedBu) {
  if (!isSuperAdmin(admin)) {
    // A bu_admin is always locked to their own unit, no matter what (or
    // whether) a filter was requested — defense in depth against a client
    // sending an arbitrary p_business_unit.
    return admin.unitScope;
  }
  if (requestedBu && VALID_BUSINESS_UNITS.includes(requestedBu)) {
    return requestedBu;
  }
  return null;
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.admin)) {
    return res.status(403).json({ error: 'This action requires an All-Units (super admin) session' });
  }
  return next();
}

// ============================================================================
// Auth / session endpoints (spec §1.5 "Auth/session RPCs", §3.2)
//
// Identity layer: Microsoft/Entra OAuth (reusing the existing "WCT Job
// Application" Azure app registration, per product owner instruction,
// 2026-09-11), verified server-side via src/lib/oauthVerify.js — NOT a
// trusted client-supplied email/admin_user_id. Authorization stays exactly
// as originally designed: an OAuth-verified identity only becomes a usable
// admin session if a matching, active `admin_users` row with at least one
// `admin_grants` row exists (spec §2.6/§1.5) — the OAuth layer itself allows
// any Microsoft account (work/school or personal; the app registration's
// "Supported account types" is "All Microsoft account users"), so this
// grants lookup is what actually restricts admin access, same as before.
// ============================================================================

// POST /api/admin/auth/microsoft  { id_token }
// Verifies the Microsoft ID token (from MSAL.js on the admin frontend,
// signed in against the separate "WCT Admin" Azure app registration —
// ADMIN_MS_CLIENT_ID, distinct from candidate sign-in's MS_CLIENT_ID), then
// reports
// whether that verified identity has any admin grants — the admin-side
// equivalent of rpc_admin_get_my_grants. Mirrors the reference app's
// attemptAdminBootstrap(): the frontend calls this right after MSAL sign-in,
// then either shows "not set up as an admin" (authorized: false), a BU
// picker (bu_grants.length > 1), or proceeds straight to /auth/session.
router.post('/auth/microsoft', asyncHandler(async (req, res) => {
  const { id_token: idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'id_token is required' });

  let identity;
  try {
    identity = await verifyMicrosoftIdToken(idToken, process.env.ADMIN_MS_CLIENT_ID);
  } catch (err) {
    return res.status(401).json({ error: `Invalid Microsoft sign-in: ${err.message}` });
  }

  const { rows } = await db.query(
    'SELECT id, email, is_active FROM admin_users WHERE email = $1',
    [identity.email]
  );
  if (rows.length === 0 || !rows[0].is_active) {
    return res.json({ authorized: false, is_super_admin: false, bu_grants: [] });
  }

  const adminUser = rows[0];
  // First-sign-in linking (spec §2.6: auth_user_id stays NULL until first
  // successful sign-in) — now the real Entra `oid` claim, verified above.
  await db.query(
    `UPDATE admin_users SET auth_user_id = COALESCE(auth_user_id, $1) WHERE id = $2`,
    [identity.subject, adminUser.id]
  );

  const grants = await db.query(
    'SELECT role, business_unit FROM admin_grants WHERE admin_user_id = $1',
    [adminUser.id]
  );
  const isSuper = grants.rows.some((g) => g.role === 'super_admin');
  const buGrants = grants.rows.filter((g) => g.role === 'bu_admin').map((g) => g.business_unit);

  return res.json({
    authorized: grants.rows.length > 0,
    is_super_admin: isSuper,
    bu_grants: buGrants,
    admin_user_id: adminUser.id,
    email: adminUser.email,
  });
}));

// POST /api/admin/auth/session  (rpc_admin_create_session)
// Takes the SAME id_token again (not a bare admin_user_id) and re-verifies
// it, so the session that gets minted is always tied to a token this server
// itself just checked the signature of — a client can no longer mint a
// session for an arbitrary admin_user_id by simply naming one.
router.post('/auth/session', asyncHandler(async (req, res) => {
  const { id_token: idToken, business_unit: businessUnit } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'id_token is required' });

  let identity;
  try {
    identity = await verifyMicrosoftIdToken(idToken, process.env.ADMIN_MS_CLIENT_ID);
  } catch (err) {
    return res.status(401).json({ error: `Invalid Microsoft sign-in: ${err.message}` });
  }

  const adminRows = await db.query(
    'SELECT id, email, is_active FROM admin_users WHERE email = $1',
    [identity.email]
  );
  if (adminRows.rows.length === 0 || !adminRows.rows[0].is_active) {
    return res.status(403).json({ error: 'Admin account not found or inactive' });
  }
  const adminUserId = adminRows.rows[0].id;

  const grants = await db.query(
    'SELECT role, business_unit FROM admin_grants WHERE admin_user_id = $1',
    [adminUserId]
  );
  const isSuper = grants.rows.some((g) => g.role === 'super_admin');

  let unitScope;
  if (isSuper) {
    // null business_unit is only valid for super admins ("ALL") — spec §1.5.
    unitScope = 'ALL';
  } else {
    const buGrants = grants.rows.filter((g) => g.role === 'bu_admin').map((g) => g.business_unit);
    if (buGrants.length === 0) {
      return res.status(403).json({ error: 'This account has no admin grants' });
    }
    if (!businessUnit || !buGrants.includes(businessUnit)) {
      return res.status(400).json({ error: `business_unit must be one of your granted units: ${buGrants.join(', ')}` });
    }
    unitScope = businessUnit;
  }

  const token = jwt.sign(
    { admin_user_id: adminUserId, unit_scope: unitScope, email: adminRows.rows[0].email },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h' }
  );

  return res.json({ token, unit_scope: unitScope });
}));

// POST /api/admin/auth/login  (rpc_admin_login — legacy break-glass fallback)
// Kept per spec §1.5/§3.2 explicitly so admin functionality isn't silently
// lost if the Entra integration ever breaks — not linked from any normal UI
// flow. Seed `admin_config.passcode_hash` out-of-band (e.g. a one-off script
// hashing ADMIN_BREAK_GLASS_PASSCODE with bcrypt) — this endpoint only ever
// compares against the stored hash, never a live env-var plaintext compare.
router.post('/auth/login', asyncHandler(async (req, res) => {
  const { passcode } = req.body || {};
  if (!passcode) return res.status(400).json({ error: 'passcode is required' });

  const { rows } = await db.query('SELECT passcode_hash FROM admin_config ORDER BY created_at DESC LIMIT 1');
  if (rows.length === 0) {
    return res.status(503).json({ error: 'Break-glass passcode is not configured' });
  }

  const ok = await bcrypt.compare(passcode, rows[0].passcode_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid passcode' });
  }

  // The break-glass path is not tied to any specific admin_users row/BU —
  // it grants full ('ALL') scope, matching its "manual super-admin override"
  // purpose. admin_user_id is null in the resulting token; downstream code
  // must not assume it's always a real admin_users.id (e.g. admin
  // user/grant-management endpoints below are still reachable with an 'ALL'
  // break-glass token, which is intentional — it's the emergency override).
  const token = jwt.sign(
    { admin_user_id: null, unit_scope: 'ALL', email: null, breakGlass: true },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h' }
  );

  return res.json({ token, unit_scope: 'ALL' });
}));

// Everything below requires a valid admin session token.
router.use(requireAdminAuth);

// GET /api/admin/me — the signed-in admin's own display name/email/scope.
// The admin JWT itself only carries `email` (see requireAdminAuth) and the
// Microsoft ID token's `name` claim is only ever read once, at the moment of
// a fresh MSAL sign-in (frontend's attemptAdminBootstrap()) — MSAL's popup
// flow doesn't leave a restorable session behind the way the original
// Supabase Auth session did. So on a plain page reload (adminToken already
// sitting in localStorage, no fresh ID token to read a name from) the
// frontend has nothing to show in the topbar profile chip / Log out button
// unless it asks the server. This route exists purely for that: it's called
// once on load whenever a token is present but no profile has been loaded
// into memory yet.
router.get('/me', asyncHandler(async (req, res) => {
  if (!req.admin.adminUserId) {
    // Break-glass passcode session (see /auth/login above) — not tied to
    // any admin_users row, so there's no real name/email to return.
    return res.json({ email: null, display_name: 'Break-glass admin', unit_scope: req.admin.unitScope });
  }
  const { rows } = await db.query('SELECT email, display_name FROM admin_users WHERE id = $1', [req.admin.adminUserId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Admin not found' });
  return res.json({
    email: rows[0].email,
    display_name: rows[0].display_name || rows[0].email,
    unit_scope: req.admin.unitScope,
  });
}));

// ============================================================================
// Dashboard / search / stats (spec §1.5 "Dashboard / search / stats")
// ============================================================================

// GET /api/admin/applications  (rpc_admin_search_applications)
router.get('/applications', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.page_size, 10) || 20));
  const search = req.query.search ? String(req.query.search).trim() : null;
  const status = req.query.status ? String(req.query.status) : null;
  const bu = effectiveBusinessUnitFilter(req.admin, req.query.business_unit);

  // Draft applications are the candidate's own in-progress work and have
  // not been submitted — admins and business unit managers must never see
  // them, regardless of business unit scope or the status filter chosen.
  const conditions = [`status != 'draft'`];
  const values = [];
  let i = 1;

  if (bu) {
    conditions.push(`business_unit = $${i++}`);
    values.push(bu);
  }
  if (status && status !== 'draft' && ALL_KNOWN_STATUSES.includes(status)) {
    conditions.push(`status = $${i++}`);
    values.push(status);
  }
  if (search) {
    conditions.push(`(
      name_nric ILIKE $${i} OR reference_no ILIKE $${i} OR email ILIKE $${i} OR
      mobile_phone ILIKE $${i} OR nric_new ILIKE $${i} OR passport_number ILIKE $${i}
    )`);
    values.push(`%${search}%`);
    i += 1;
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await db.query(`SELECT count(*)::int AS total FROM applications ${whereSql}`, values);
  const total = countResult.rows[0].total;

  const dataValues = values.concat([pageSize, (page - 1) * pageSize]);
  const { rows } = await db.query(
    `SELECT * FROM applications ${whereSql} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`,
    dataValues
  );

  return res.json({ rows, total });
}));

// GET /api/admin/stats  (rpc_admin_get_stats)
router.get('/stats', asyncHandler(async (req, res) => {
  const bu = effectiveBusinessUnitFilter(req.admin, req.query.business_unit);
  // Same draft exclusion as /applications — stats shown to admins/BU
  // managers must not reflect applications that haven't been submitted.
  const conditions = [`status != 'draft'`];
  const values = [];
  if (bu) { values.push(bu); conditions.push(`business_unit = $${values.length}`); }
  const whereSql = `WHERE ${conditions.join(' AND ')}`;

  const totalResult = await db.query(`SELECT count(*)::int AS total FROM applications ${whereSql}`, values);
  const byStatusResult = await db.query(
    `SELECT status, count(*)::int AS count FROM applications ${whereSql} GROUP BY status`,
    values
  );

  const byStatus = {};
  for (const s of ALL_KNOWN_STATUSES) byStatus[s] = 0;
  for (const row of byStatusResult.rows) byStatus[row.status] = row.count;

  return res.json({ total: totalResult.rows[0].total, by_status: byStatus });
}));

// GET /api/admin/exit-interviews/pending-count  (rpc_admin_count_pending_exit_signatures)
router.get('/exit-interviews/pending-count', asyncHandler(async (req, res) => {
  const bu = effectiveBusinessUnitFilter(req.admin, null);
  const conditions = ['ei.employee_signed = true', 'ei.hr_signed = false'];
  const values = [];
  if (bu) {
    conditions.push(`a.business_unit = $1`);
    values.push(bu);
  }
  const { rows } = await db.query(
    `SELECT count(*)::int AS count
       FROM exit_interviews ei
       JOIN applications a ON a.id = ei.application_id
      WHERE ${conditions.join(' AND ')}`,
    values
  );
  return res.json({ count: rows[0].count });
}));

// GET /api/admin/export  (rpc_admin_export_all — applications LEFT JOIN onboarding_records)
router.get('/export', asyncHandler(async (req, res) => {
  const bu = effectiveBusinessUnitFilter(req.admin, req.query.business_unit);
  // Exports must not leak candidates' unsubmitted draft applications either.
  const conditions = [`a.status != 'draft'`];
  const values = [];
  if (bu) { values.push(bu); conditions.push(`a.business_unit = $${values.length}`); }
  const whereSql = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await db.query(
    `SELECT a.*,
            o.status              AS ob_status,
            o.epf_no              AS ob_epf_no,
            o.income_tax_no       AS ob_income_tax_no,
            o.tax_branch          AS ob_tax_branch,
            o.socso_no            AS ob_socso_no,
            o.bank_account_no     AS ob_bank_account_no,
            o.cidb_green_card_no  AS ob_cidb_green_card_no,
            o.cidb_branch         AS ob_cidb_branch,
            o.spouse_name        AS ob_spouse_name,
            o.spouse_nric        AS ob_spouse_nric,
            o.spouse_date_of_birth AS ob_spouse_date_of_birth,
            o.spouse_working     AS ob_spouse_working,
            o.children_below_18  AS ob_children_below_18,
            o.children_18_to_23  AS ob_children_18_to_23,
            o.emergency_contacts AS ob_emergency_contacts,
            o.beneficiary_name   AS ob_beneficiary_name,
            o.beneficiary_relationship AS ob_beneficiary_relationship,
            o.beneficiary_contact AS ob_beneficiary_contact,
            o.tp3_data           AS ob_tp3_data,
            o.salary_company     AS ob_salary_company,
            o.salary_bank        AS ob_salary_bank,
            o.salary_branch      AS ob_salary_branch,
            o.salary_account_no  AS ob_salary_account_no,
            o.salary_ic_submitted AS ob_salary_ic_submitted,
            o.personal_details_confirmed    AS ob_personal_details_confirmed,
            o.personal_details_confirmed_at AS ob_personal_details_confirmed_at,
            o.tp3_confirmed      AS ob_tp3_confirmed,
            o.tp3_confirmed_at   AS ob_tp3_confirmed_at,
            o.salary_crediting_confirmed    AS ob_salary_crediting_confirmed,
            o.salary_crediting_confirmed_at AS ob_salary_crediting_confirmed_at
       FROM applications a
       LEFT JOIN onboarding_records o ON o.application_id = a.id
       ${whereSql}
       ORDER BY a.created_at DESC`,
    values
  );
  return res.json(rows);
}));

// GET /api/admin/companies  (rpc_admin_list_companies — lightweight id/name lookup)
router.get('/companies', asyncHandler(async (req, res) => {
  const bu = effectiveBusinessUnitFilter(req.admin, req.query.business_unit);
  const whereSql = bu ? 'WHERE business_unit = $1' : '';
  const values = bu ? [bu] : [];
  const { rows } = await db.query(`SELECT id, name, category FROM companies ${whereSql} ORDER BY category NULLS LAST, name`, values);
  return res.json(rows);
}));

// ============================================================================
// Single-application admin endpoints
// ============================================================================

async function fetchScopedApplication(req, res) {
  // A draft is not visible to admin/BU-manager views at all (see /applications,
  // /stats, /export above) — 404 here too rather than 200'ing a record no
  // listing endpoint would ever surface, in case a draft's id is guessed directly.
  const { rows } = await db.query("SELECT * FROM applications WHERE id = $1 AND status != 'draft'", [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'Application not found' });
    return null;
  }
  const app = rows[0];
  if (!isSuperAdmin(req.admin) && app.business_unit !== req.admin.unitScope) {
    res.status(403).json({ error: "This application is outside your business unit's scope" });
    return null;
  }
  return app;
}

// GET /api/admin/applications/:id  (rpc_admin_get_application)
router.get('/applications/:id', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;
  return res.json(app);
}));

// PATCH /api/admin/applications/:id  (rpc_admin_update_application — limited correction fields)
router.patch('/applications/:id', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;

  const patch = { ...(req.body || {}) };

  // business_unit reassignment is only ever allowed for an All-Units admin
  // (spec §1.5) — a bu_admin's patch must never include it, even if sent
  // (defense in depth beyond the UI hiding the control).
  if (Object.prototype.hasOwnProperty.call(patch, 'business_unit') && !isSuperAdmin(req.admin)) {
    return res.status(403).json({ error: 'Only an All-Units admin may reassign business_unit' });
  }
  if (patch.business_unit && !VALID_BUSINESS_UNITS.includes(patch.business_unit)) {
    return res.status(400).json({ error: `business_unit must be one of ${VALID_BUSINESS_UNITS.join(', ')}` });
  }

  // `position_applying` is candidate-set on the application form and shown
  // read-only to admins (spec-equivalent correction fields below stay
  // limited to contact/BU details); it was reinstated 2026-09-17 (see
  // db/migrations/004_re_add_position_applying.sql).
  const allowedColumns = ['name_nric', 'email', 'mobile_phone', 'business_unit', 'position_applying'];
  const update = buildPatchUpdate('applications', 'id', req.params.id, patch, allowedColumns);
  if (!update) return res.json(app);

  const { rows } = await db.query(update.text, update.values);
  const updated = rows[0];

  // Power Automate notification (mirrors the original
  // `notify_power_automate_on_bu_transfer` trigger) — only fires on an
  // actual business_unit change away from 'draft'.
  if (
    Object.prototype.hasOwnProperty.call(patch, 'business_unit') &&
    patch.business_unit !== app.business_unit &&
    updated.status !== 'draft'
  ) {
    const notifyEmail = await getManagerEmail(updated.business_unit);
    notify('bu_transfer', sanitizeNotificationPayload({
      ...updated,
      notify_email: notifyEmail,
      from_business_unit: app.business_unit || '',
    }));
  }

  return res.json(updated);
}));

// DELETE /api/admin/applications/:id  (rpc_admin_delete_application)
router.delete('/applications/:id', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;
  await db.query('DELETE FROM applications WHERE id = $1', [req.params.id]);
  return res.status(204).send();
}));

// GET /api/admin/applications/:id/other-bu  (rpc_admin_check_other_bu)
router.get('/applications/:id/other-bu', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;

  // Matched by NRIC/passport/email, per spec §1.5 (best-effort — never
  // errors the whole request if nothing matches).
  const { rows } = await db.query(
    `SELECT reference_no, business_unit, status
       FROM applications
      WHERE id != $1
        AND business_unit != $2
        AND (
          (nric_new IS NOT NULL AND nric_new = $3) OR
          (passport_number IS NOT NULL AND passport_number = $4) OR
          (email IS NOT NULL AND email = $5)
        )`,
    [app.id, app.business_unit, app.nric_new, app.passport_number, app.email]
  );
  return res.json(rows);
}));

// GET /api/admin/applications/:id/exit-interview  (rpc_admin_get_exit_interview)
router.get('/applications/:id/exit-interview', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;
  const { rows } = await db.query('SELECT * FROM exit_interviews WHERE application_id = $1', [app.id]);
  return res.json(rows[0] || null);
}));

// GET /api/admin/applications/:id/onboarding  (rpc_admin_get_onboarding)
// Admin read-only view of a candidate's onboarding record — the candidate-
// facing GET /api/onboarding/:application_id (onboarding.js) is scoped to
// `user_id = req.user.id` and can't be reused here, so this is a separate,
// BU-scoped-via-fetchScopedApplication endpoint rather than a shared route.
router.get('/applications/:id/onboarding', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;
  const { rows } = await db.query('SELECT * FROM onboarding_records WHERE application_id = $1', [app.id]);
  return res.json(rows[0] || null);
}));

// ============================================================================
// Status transitions
// ============================================================================

// POST /api/admin/applications/:id/status  (rpc_admin_update_status)
router.post('/applications/:id/status', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;

  const { status } = req.body || {};
  if (!GENERIC_STATUS_OPTIONS.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${GENERIC_STATUS_OPTIONS.join(', ')} (use the dedicated offboarding endpoint for that transition)` });
  }

  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'UPDATE applications SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    const updated = rows[0];

    if (status === 'blacklisted' && updated.email) {
      await client.query(
        `INSERT INTO candidate_blacklist (email, is_blacklisted, reason)
         VALUES ($1, true, 'Set via admin status transition')
         ON CONFLICT (email) DO UPDATE SET is_blacklisted = true`,
        [updated.email]
      );
    }

    return updated;
  });

  // Power Automate notification (mirrors the original
  // `notify_power_automate_on_status_change` trigger) — only for the
  // HR-visible transitions the original trigger fired on.
  const NOTIFY_STATUSES = ['under_review', 'shortlisted', 'interview_scheduled', 'offer_sent', 'hired', 'rejected', 'withdrawn', 'blacklisted'];
  if (NOTIFY_STATUSES.includes(result.status)) {
    const notifyEmail = await getManagerEmail(result.business_unit);
    notify('status_change', sanitizeNotificationPayload({ ...result, notify_email: notifyEmail }));
  }

  return res.json(result);
}));

// POST /api/admin/applications/:id/offboarding  (rpc_admin_set_offboarding)
router.post('/applications/:id/offboarding', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;

  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE applications SET status = 'offboarding' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    const updated = rows[0];

    await client.query(
      `INSERT INTO exit_interviews (application_id)
       VALUES ($1)
       ON CONFLICT (application_id) DO NOTHING`,
      [req.params.id]
    );

    return updated;
  });

  // Power Automate notification (mirrors the original
  // `rpc_admin_set_offboarding`'s own notify call — shares one workflow with
  // the employee-signed/hr-signed exit-interview events below, distinguished
  // by `event_type`).
  notify('exit_interview', {
    event_type: 'fill_exit_interview',
    application_id: result.id,
    reference_no: result.reference_no || '',
    candidate_name: result.name_nric || '',
    candidate_email: result.email || '',
    business_unit: result.business_unit || '',
    exit_interview_link: `${FRONTEND_BASE_URL}/index.html?exit=${result.id}`,
  });

  return res.json(result);
}));

// POST /api/admin/exit-interviews/:application_id/sign  (rpc_admin_sign_exit_interview)
router.post('/exit-interviews/:application_id/sign', asyncHandler(async (req, res) => {
  const appRows = await db.query('SELECT * FROM applications WHERE id = $1', [req.params.application_id]);
  if (appRows.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
  const app = appRows.rows[0];
  if (!isSuperAdmin(req.admin) && app.business_unit !== req.admin.unitScope) {
    return res.status(403).json({ error: "This application is outside your business unit's scope" });
  }

  const { hr_name: hrName, hr_position: hrPosition } = req.body || {};
  if (!hrName || !hrPosition) {
    return res.status(400).json({ error: 'hr_name and hr_position are required' });
  }

  const eiRows = await db.query('SELECT * FROM exit_interviews WHERE application_id = $1', [req.params.application_id]);
  if (eiRows.rows.length === 0) {
    return res.status(404).json({ error: 'No exit interview record for this application' });
  }
  if (!eiRows.rows[0].employee_signed) {
    return res.status(409).json({ error: "Section D can't be completed before the employee's Section A-C signature" });
  }

  const { rows } = await db.query(
    `UPDATE exit_interviews
       SET hr_signed = true, hr_signed_name = $1, hr_signed_position = $2, hr_signed_at = now()
     WHERE application_id = $3
     RETURNING *`,
    [hrName, hrPosition, req.params.application_id]
  );
  const ei = rows[0];

  // Power Automate notification (mirrors the original
  // `notify_power_automate_on_exit_interview_signed` trigger's 'hr_signed' branch).
  notify('exit_interview', {
    event_type: 'hr_signed',
    application_id: req.params.application_id,
    reference_no: app.reference_no || '',
    candidate_name: app.name_nric || '',
    candidate_email: app.email || '',
    position: ei.position || '',
    business_unit: app.business_unit || '',
    hr_signed_name: ei.hr_signed_name || '',
    hr_signed_position: ei.hr_signed_position || '',
    hr_signed_at: ei.hr_signed_at ? String(ei.hr_signed_at) : '',
    exit_interview_link: `${FRONTEND_BASE_URL}/index.html?exit=${req.params.application_id}`,
  });

  return res.json(ei);
}));

// ============================================================================
// Company / entity management (spec §1.5, §5.7)
// ============================================================================

// GET /api/admin/companies/manage  (rpc_admin_list_companies_for_management)
router.get('/companies/manage', asyncHandler(async (req, res) => {
  const bu = effectiveBusinessUnitFilter(req.admin, req.query.business_unit);
  const whereSql = bu ? 'WHERE business_unit = $1' : '';
  const values = bu ? [bu] : [];
  const { rows } = await db.query(
    `SELECT id, name, category, business_unit FROM companies ${whereSql} ORDER BY name`,
    values
  );
  return res.json(rows);
}));

// POST /api/admin/companies  (rpc_admin_create_company)
router.post('/companies', asyncHandler(async (req, res) => {
  const { name, category, business_unit: businessUnit } = req.body || {};
  if (!name || !businessUnit) {
    return res.status(400).json({ error: 'name and business_unit are required' });
  }
  if (!VALID_BUSINESS_UNITS.includes(businessUnit)) {
    return res.status(400).json({ error: `business_unit must be one of ${VALID_BUSINESS_UNITS.join(', ')}` });
  }
  // A bu_admin can only create within their own BU — server-enforced
  // regardless of what business_unit value is sent (spec §1.5).
  if (!isSuperAdmin(req.admin) && businessUnit !== req.admin.unitScope) {
    return res.status(403).json({ error: 'You may only create companies within your own business unit' });
  }

  // `companies.category` is meant to always be "one of entity_categories.name"
  // (see the schema comment on that column) but nothing was actually
  // enforcing or maintaining that: the frontend's "+ Add new entity..."
  // inline option on this very form lets an admin type a brand-new category
  // name right here, and until now that name only ever landed on this one
  // company row — it was never inserted into entity_categories, so it could
  // never show up on the Business Unit Settings page (permission matrix) for
  // an All-Units admin to grant BU access to. Upserting it here (idempotent,
  // same as POST /entity-categories) closes that gap for every company
  // created from now on, whether the category was picked from the dropdown
  // or typed as new.
  if (category) {
    await db.query('INSERT INTO entity_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [category]);
  }

  const { rows } = await db.query(
    'INSERT INTO companies (name, category, business_unit) VALUES ($1, $2, $3) RETURNING *',
    [name, category || null, businessUnit]
  );
  return res.status(201).json(rows[0]);
}));

async function fetchScopedCompany(req, res) {
  const { rows } = await db.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'Company not found' });
    return null;
  }
  const company = rows[0];
  if (!isSuperAdmin(req.admin) && company.business_unit !== req.admin.unitScope) {
    res.status(403).json({ error: "This company is outside your business unit's scope" });
    return null;
  }
  return company;
}

// PATCH /api/admin/companies/:id  (rpc_admin_update_company — name/category only)
router.patch('/companies/:id', asyncHandler(async (req, res) => {
  const company = await fetchScopedCompany(req, res);
  if (!company) return;

  const update = buildPatchUpdate('companies', 'id', req.params.id, req.body || {}, ['name', 'category']);
  if (!update) return res.json(company);

  const { rows } = await db.query(update.text, update.values);
  return res.json(rows[0]);
}));

// DELETE /api/admin/companies/:id  (rpc_admin_delete_company)
router.delete('/companies/:id', asyncHandler(async (req, res) => {
  const company = await fetchScopedCompany(req, res);
  if (!company) return;
  await db.query('DELETE FROM companies WHERE id = $1', [req.params.id]);
  return res.status(204).send();
}));

// POST /api/admin/applications/:id/company  (rpc_admin_assign_company)
router.post('/applications/:id/company', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;

  const { company_id: companyId } = req.body || {};
  if (companyId) {
    const companyRows = await db.query('SELECT * FROM companies WHERE id = $1', [companyId]);
    if (companyRows.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    const targetCompany = companyRows.rows[0];
    if (req.admin.unitScope !== 'ALL' && targetCompany.business_unit !== req.admin.unitScope) {
      return res.status(403).json({ error: 'Cannot assign a company outside your business unit' });
    }
  }

  const { rows } = await db.query(
    'UPDATE applications SET company_id = $1 WHERE id = $2 RETURNING *',
    [companyId || null, req.params.id]
  );
  return res.json(rows[0]);
}));

// GET /api/admin/entity-categories  (rpc_admin_list_entity_categories)
router.get('/entity-categories', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT name FROM entity_categories ORDER BY name');
  return res.json(rows.map((r) => r.name));
}));

// POST /api/admin/entity-categories  (rpc_admin_add_entity_category)
router.post('/entity-categories', asyncHandler(async (req, res) => {
  const { category } = req.body || {};
  if (!category) return res.status(400).json({ error: 'category is required' });
  await db.query('INSERT INTO entity_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [category]);
  return res.status(201).json({ ok: true });
}));

// PATCH /api/admin/entity-categories/:name — rename an entity category, or
// merge it into an existing one if :newName already exists (e.g. cleaning up
// an accidental case-only duplicate like "aviation" vs "Aviation"). All-Units
// admin only, same as the rest of the permission-matrix page this powers.
// `entity_categories.name` is a plain-text primary key with no ON UPDATE
// CASCADE to `admin_unit_permissions.category` (and `companies.category`
// isn't a real foreign key at all — see its schema comment), so every
// dependent row is repointed by hand inside one transaction rather than
// relying on the database to cascade the rename.
router.patch('/entity-categories/:name', requireSuperAdmin, asyncHandler(async (req, res) => {
  const oldName = req.params.name;
  const newName = (req.body && req.body.name || '').trim();
  if (!newName) return res.status(400).json({ error: 'name is required' });

  const existing = await db.query('SELECT 1 FROM entity_categories WHERE name = $1', [oldName]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Entity category not found' });
  if (newName === oldName) return res.json({ ok: true, name: newName });

  await db.withTransaction(async (client) => {
    // Ensure the target name exists — covers both a plain rename (target
    // didn't exist yet) and a merge (target already did).
    await client.query('INSERT INTO entity_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [newName]);

    // Repoint every company filed under the old name.
    await client.query('UPDATE companies SET category = $1 WHERE category = $2', [newName, oldName]);

    // Merge permission grants rather than overwrite: a unit keeps access if
    // it was granted under EITHER the old or the new name.
    const oldGrants = await client.query('SELECT unit_scope, granted FROM admin_unit_permissions WHERE category = $1', [oldName]);
    for (const g of oldGrants.rows) {
      await client.query(
        `INSERT INTO admin_unit_permissions (category, unit_scope, granted)
         VALUES ($1, $2, $3)
         ON CONFLICT (category, unit_scope) DO UPDATE SET granted = admin_unit_permissions.granted OR $3`,
        [newName, g.unit_scope, g.granted]
      );
    }

    // Dropping the old category row cascades to remove its now-redundant
    // admin_unit_permissions rows (ON DELETE CASCADE, see schema).
    await client.query('DELETE FROM entity_categories WHERE name = $1', [oldName]);
  });

  return res.json({ ok: true, name: newName });
}));

// DELETE /api/admin/entity-categories/:name — All-Units admin only. Refuses
// to delete a category still in use by any company, rather than silently
// leaving those companies pointed at a category name that no longer exists
// in entity_categories (which is exactly the "invisible on Business Unit
// Settings" bug this whole feature was built to close — see the POST
// /companies comment above).
router.delete('/entity-categories/:name', requireSuperAdmin, asyncHandler(async (req, res) => {
  const name = req.params.name;
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM companies WHERE category = $1', [name]);
  const inUseCount = rows[0].n;
  if (inUseCount > 0) {
    return res.status(409).json({
      error: `Cannot delete — ${inUseCount} compan${inUseCount === 1 ? 'y' : 'ies'} still use this entity category. Reassign them to a different category first.`,
    });
  }
  await db.query('DELETE FROM entity_categories WHERE name = $1', [name]);
  return res.status(204).send();
}));

// ============================================================================
// Business-unit permission matrix (spec §1.5, §5.8 — All-Units only)
// ============================================================================

// GET /api/admin/permission-matrix  (rpc_admin_get_permission_matrix)
router.get('/permission-matrix', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT category, unit_scope, granted FROM admin_unit_permissions');
  return res.json(rows);
}));

// PUT /api/admin/permission-matrix  (rpc_admin_save_permissions — full-replace-set per unit_scope)
router.put('/permission-matrix', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { unit_scope: unitScope, categories } = req.body || {};
  if (!VALID_BUSINESS_UNITS.includes(unitScope) || !Array.isArray(categories)) {
    return res.status(400).json({ error: 'unit_scope (one of E&C/Land/Mall) and categories (array) are required' });
  }

  await db.withTransaction(async (client) => {
    const allCategories = await client.query('SELECT name FROM entity_categories');
    const grantedSet = new Set(categories);

    for (const { name } of allCategories.rows) {
      await client.query(
        `INSERT INTO admin_unit_permissions (category, unit_scope, granted)
         VALUES ($1, $2, $3)
         ON CONFLICT (category, unit_scope) DO UPDATE SET granted = $3`,
        [name, unitScope, grantedSet.has(name)]
      );
    }
  });

  return res.json({ ok: true });
}));

// ============================================================================
// Manager notification settings (spec §1.5, §2.6 — retired from nav, kept
// for parity; All-Units only)
// ============================================================================

// GET /api/admin/settings  (rpc_admin_get_settings)
router.get('/settings', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT manager_email_ec, manager_email_mall, manager_email_land FROM manager_settings ORDER BY created_at DESC LIMIT 1');
  return res.json(rows[0] || { manager_email_ec: null, manager_email_mall: null, manager_email_land: null });
}));

// PUT /api/admin/settings  (rpc_admin_update_settings)
router.put('/settings', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { manager_email_ec: ec, manager_email_mall: mall, manager_email_land: land } = req.body || {};

  const existing = await db.query('SELECT id FROM manager_settings ORDER BY created_at DESC LIMIT 1');
  let row;
  if (existing.rows.length === 0) {
    const inserted = await db.query(
      'INSERT INTO manager_settings (manager_email_ec, manager_email_mall, manager_email_land) VALUES ($1, $2, $3) RETURNING *',
      [ec || null, mall || null, land || null]
    );
    row = inserted.rows[0];
  } else {
    const updated = await db.query(
      'UPDATE manager_settings SET manager_email_ec = $1, manager_email_mall = $2, manager_email_land = $3 WHERE id = $4 RETURNING *',
      [ec || null, mall || null, land || null, existing.rows[0].id]
    );
    row = updated.rows[0];
  }
  return res.json(row);
}));

// ============================================================================
// Admin user / access management (spec §1.5, §5.9 — Super Admin only)
// ============================================================================

// GET /api/admin/admins  (rpc_admin_list_admins — flat rows, one per grant)
router.get('/admins', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT au.id AS admin_user_id, au.email, au.display_name, au.is_active,
           (au.auth_user_id IS NOT NULL) AS linked,
           g.id AS grant_id, g.role, g.business_unit
      FROM admin_users au
      LEFT JOIN admin_grants g ON g.admin_user_id = au.id
     ORDER BY au.email, g.role
  `);
  return res.json(rows);
}));

// POST /api/admin/admins  (rpc_admin_invite_admin)
router.post('/admins', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { email, display_name: displayName } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (!email.toLowerCase().endsWith('@wct.my')) {
    // UI-hinted requirement (spec §1.5) — enforced here as a hard rule.
    return res.status(400).json({ error: 'Admin accounts must use an @wct.my email address' });
  }

  const existing = await db.query('SELECT id FROM admin_users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An admin with this email already exists' });
  }

  const { rows } = await db.query(
    'INSERT INTO admin_users (email, display_name) VALUES ($1, $2) RETURNING *',
    [email.toLowerCase(), displayName || null]
  );
  const invited = rows[0];

  // Power Automate notification (mirrors the original `rpc_admin_invite_admin`).
  // `req.admin.email` is this session's own signed-in admin (the inviter);
  // the original RPC looked up a display_name via auth.uid() with the same
  // fallback-to-email-then-generic-label chain reproduced here.
  const inviterRows = await db.query('SELECT display_name, email FROM admin_users WHERE id = $1', [req.admin.adminUserId]);
  const inviter = inviterRows.rows[0];
  notify('invite_admin', {
    invited_email: invited.email,
    invited_name: invited.display_name || '',
    invited_by_name: (inviter && (inviter.display_name || inviter.email)) || 'A Super Admin',
    admin_login_link: `${FRONTEND_BASE_URL}/admin.html`,
  });

  return res.status(201).json(invited);
}));

// POST /api/admin/admins/:admin_user_id/grants  (rpc_admin_grant_role)
router.post('/admins/:admin_user_id/grants', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { role, business_unit: businessUnit } = req.body || {};
  if (role === 'entity_admin') {
    // Explicitly Phase 2 / not implemented per spec §1.5 — refuse rather
    // than silently creating an unenforced grant.
    return res.status(501).json({ error: "The 'entity_admin' role is defined as Phase 2 and is not implemented" });
  }
  if (!['super_admin', 'bu_admin'].includes(role)) {
    return res.status(400).json({ error: "role must be 'super_admin' or 'bu_admin'" });
  }
  if (role === 'bu_admin' && !VALID_BUSINESS_UNITS.includes(businessUnit)) {
    return res.status(400).json({ error: 'business_unit is required for a bu_admin grant' });
  }
  if (role === 'super_admin' && businessUnit) {
    return res.status(400).json({ error: 'business_unit must not be set for a super_admin grant' });
  }

  const adminRows = await db.query('SELECT id, email, display_name FROM admin_users WHERE id = $1', [req.params.admin_user_id]);
  if (adminRows.rows.length === 0) return res.status(404).json({ error: 'Admin user not found' });
  const targetAdmin = adminRows.rows[0];

  const { rows } = await db.query(
    'INSERT INTO admin_grants (admin_user_id, role, business_unit) VALUES ($1, $2, $3) RETURNING *',
    [req.params.admin_user_id, role, role === 'bu_admin' ? businessUnit : null]
  );
  const grant = rows[0];

  // Power Automate notification — see the `admin_permission_change` comment
  // in lib/powerAutomate.js: this shares one flow/webhook with grant-revoke
  // and admin-active, switched on `event_type`.
  const granterRows = await db.query('SELECT display_name FROM admin_users WHERE id = $1', [req.admin.adminUserId]);
  const granter = granterRows.rows[0];
  notify('admin_permission_change', {
    event_type: 'grant_added',
    target_email: targetAdmin.email,
    target_name: targetAdmin.display_name || targetAdmin.email,
    role: grant.role,
    business_unit: grant.business_unit || '',
    role_label: formatRoleLabel(grant.role, grant.business_unit),
    changed_by_name: (granter && granter.display_name) || 'A Super Admin',
    admin_login_link: `${FRONTEND_BASE_URL}/admin.html`,
  });

  return res.status(201).json(grant);
}));

// DELETE /api/admin/grants/:grant_id  (rpc_admin_revoke_grant)
router.delete('/grants/:grant_id', requireSuperAdmin, asyncHandler(async (req, res) => {
  // Fetch the grant + its owning admin BEFORE deleting — the DELETE alone
  // would leave nothing to build the notification payload from.
  const grantRows = await db.query(
    `SELECT g.role, g.business_unit, au.email, au.display_name
       FROM admin_grants g
       JOIN admin_users au ON au.id = g.admin_user_id
      WHERE g.id = $1`,
    [req.params.grant_id]
  );
  if (grantRows.rows.length === 0) return res.status(404).json({ error: 'Grant not found' });
  const grant = grantRows.rows[0];

  const { rowCount } = await db.query('DELETE FROM admin_grants WHERE id = $1', [req.params.grant_id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Grant not found' });

  const revokerRows = await db.query('SELECT display_name FROM admin_users WHERE id = $1', [req.admin.adminUserId]);
  const revoker = revokerRows.rows[0];
  notify('admin_permission_change', {
    event_type: 'grant_revoked',
    target_email: grant.email,
    target_name: grant.display_name || grant.email,
    role: grant.role,
    business_unit: grant.business_unit || '',
    role_label: formatRoleLabel(grant.role, grant.business_unit),
    changed_by_name: (revoker && revoker.display_name) || 'A Super Admin',
    admin_login_link: `${FRONTEND_BASE_URL}/admin.html`,
  });

  return res.status(204).send();
}));

// PATCH /api/admin/admins/:admin_user_id/active  (rpc_admin_set_admin_active)
router.patch('/admins/:admin_user_id/active', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { is_active: isActive } = req.body || {};
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'is_active (boolean) is required' });
  }
  const { rows } = await db.query(
    'UPDATE admin_users SET is_active = $1 WHERE id = $2 RETURNING *',
    [isActive, req.params.admin_user_id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Admin user not found' });
  const target = rows[0];
  // NOTE: deactivating an admin does not retroactively invalidate any
  // already-issued session JWT before its own expiry — a known trade-off of
  // the stateless-JWT session model documented in middleware/auth.js. A
  // short ADMIN_JWT_EXPIRES_IN bounds the exposure window.

  // Power Automate notification (mirrors the original `rpc_admin_set_admin_active`).
  const changerRows = await db.query('SELECT display_name FROM admin_users WHERE id = $1', [req.admin.adminUserId]);
  const changer = changerRows.rows[0];

  // The "reactivated" email template shows a role, but reactivation isn't
  // tied to any single grant (an admin can hold more than one) — so unlike
  // grant_added/grant_revoked, this looks up ALL of the target's current
  // grants and joins their labels together (e.g. "Super Admin" or
  // "BU Admin (E&C), BU Admin (Mall)"), rather than sending one role.
  const grantRows = await db.query(
    'SELECT role, business_unit FROM admin_grants WHERE admin_user_id = $1 ORDER BY role, business_unit',
    [req.params.admin_user_id]
  );
  const roleLabel = grantRows.rows.map((g) => formatRoleLabel(g.role, g.business_unit)).join(', ');

  notify('admin_permission_change', {
    event_type: isActive ? 'reactivated' : 'deactivated',
    target_email: target.email,
    target_name: target.display_name || target.email,
    role: grantRows.rows.map((g) => g.role).join(','),
    business_unit: grantRows.rows.map((g) => g.business_unit).filter(Boolean).join(','),
    role_label: roleLabel,
    changed_by_name: (changer && changer.display_name) || 'A Super Admin',
    admin_login_link: `${FRONTEND_BASE_URL}/admin.html`,
  });

  return res.json(target);
}));

module.exports = router;
