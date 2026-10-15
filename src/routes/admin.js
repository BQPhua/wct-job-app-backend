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
// Called through the module object (not destructured) so tests can stub
// Microsoft token verification.
const oauthVerify = require('../lib/oauthVerify');
const { resolveAdminGrants, requireHrAdmin, formatRoleLabel } = require('../lib/offboarding/access');

const businessUnits = require('../lib/businessUnits');
const { sendOnboardingReminder } = require('../lib/candidateEmails');

const router = express.Router();

// Business units are a managed list (business_units table, migration 008);
// validate against it with businessUnits.isValid(), never a hard-coded list.
const badBu = async (res, code) => {
  if (await businessUnits.isValid(code)) return false;
  res.status(400).json({ error: `Unknown business unit: ${code}` });
  return true;
};

// Human-readable role labels (formatRoleLabel) live in lib/offboarding/access.js
// so the new Payroll/Clearance PIC roles are labelled consistently everywhere.
// Statuses selectable via the status-setter (spec §6.4). 'offboarding' is no
// longer an application status (2026-09-30): offboarding is its own
// invite-driven module — see routes/adminOffboarding.js.
const GENERIC_STATUS_OPTIONS = ['shortlisted', 'kiv', 'hired', 'rejected', 'blacklisted'];
const ALL_KNOWN_STATUSES = [
  'draft', 'submitted', 'under_review', 'shortlisted', 'interview_scheduled',
  'offer_sent', 'withdrawn', 'kiv', 'hired', 'rejected', 'blacklisted',
];

// Base URL of the live candidate/admin site, used to build the links in
// Power Automate notification payloads. Set FRONTEND_BASE_URL in the server's
// env file; falls back to the live address.
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://hrforms.wct.my';

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
  // Any requested unit is just a bound query value (an unknown one simply
  // matches nothing), so it needs no lookup here.
  if (typeof requestedBu === 'string' && requestedBu && requestedBu.length <= 40) {
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

// ---------------------------------------------------------------------------
// Session helpers shared by sign-in (/auth/session) and "Switch business
// unit" (/auth/switch). Both always start again from the database grants,
// never from what a client or an older token claims.
// ---------------------------------------------------------------------------
const ALL_DEPTS = [1, 2, 3, 4, 5, 6];

/** The units this person may open, in display order, for the picker. */
async function unitChoices(access) {
  const units = await businessUnits.list();
  const out = [];
  if (access.isSuper) {
    out.push({ code: 'ALL', name: 'All business units', roles: { super_admin: true } });
    units.filter((u) => u.is_active).forEach((u) => out.push({ code: u.code, name: u.name, roles: { super_admin: true, bu_admin: true, payroll_pic: true } }));
    return out;
  }
  units.forEach((u) => {
    const r = access.byBu[u.code];
    if (r) out.push({ code: u.code, name: u.name, roles: r });
  });
  if (access.isPayroll && out.length === 0) {
    out.push({ code: 'GROUP', name: 'All business units (Payroll)', roles: { payroll_pic: true, payroll_all: true } });
  }
  return out;
}

/**
 * Work out the session for `access` in `requested` unit (or the only one).
 * Returns { unitScope, roles, adminUserId } or { status, error }.
 */
function sessionFor(access, requested) {
  const adminUserId = access.adminUser ? access.adminUser.id : null;
  if (access.isSuper) {
    if (!requested || requested === 'ALL') {
      return { unitScope: 'ALL', roles: { bu_admin: true, payroll_pic: true, clearance_department_ids: ALL_DEPTS.slice() }, adminUserId };
    }
    // A super admin working inside one unit acts as its HR and payroll, and
    // signs clearance sections on behalf (never as the department PIC).
    return { unitScope: requested, roles: { bu_admin: true, payroll_pic: true, clearance_department_ids: [] }, adminUserId, checkUnit: true };
  }
  if (access.buChoices.length > 0) {
    const chosen = requested || (access.buChoices.length === 1 ? access.buChoices[0] : null);
    if (!chosen || !access.buChoices.includes(chosen)) {
      return { status: requested ? 403 : 400, error: `business_unit must be one of your granted units: ${access.buChoices.join(', ')}` };
    }
    return { unitScope: chosen, roles: access.byBu[chosen], adminUserId };
  }
  if (access.isPayroll) {
    // Payroll PIC for all units with no unit-specific grant.
    return { unitScope: 'GROUP', roles: { bu_admin: false, payroll_pic: true, payroll_all: true, clearance_department_ids: [] }, adminUserId };
  }
  if (access.superiorSections > 0) {
    // Immediate superior with no grant: may only clear the Reporting Unit
    // sections assigned to their email (enforced in lib/offboarding/access).
    return { unitScope: 'SUPERIOR', roles: { bu_admin: false, payroll_pic: false, clearance_department_ids: [] }, adminUserId: null };
  }
  return { status: 403, error: 'This account has no admin access' };
}

async function mintSession(access, email, requested) {
  const s = sessionFor(access, requested);
  if (s.error) return s;
  if (s.checkUnit && !(await businessUnits.isValid(s.unitScope))) return { status: 400, error: `Unknown business unit: ${s.unitScope}` };
  const token = jwt.sign(
    { admin_user_id: s.adminUserId, unit_scope: s.unitScope, email, roles: s.roles },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h' }
  );
  return { token, unit_scope: s.unitScope };
}

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
    identity = await oauthVerify.verifyMicrosoftIdToken(idToken, process.env.ADMIN_MS_CLIENT_ID);
  } catch (err) {
    return res.status(401).json({ error: `Invalid Microsoft sign-in: ${err.message}` });
  }

  const access = await resolveAdminGrants(identity.email);
  if (access.adminUser) {
    // First-sign-in linking (spec §2.6: auth_user_id stays NULL until first
    // successful sign-in) — now the real Entra `oid` claim, verified above.
    await db.query(
      'UPDATE admin_users SET auth_user_id = COALESCE(auth_user_id, $1) WHERE id = $2',
      [identity.subject, access.adminUser.id]
    );
  }

  // `bu_grants` = every BU in which this person holds ANY staff role
  // (bu_admin, payroll_pic or clearance_pic) — the frontend shows the BU
  // picker when there is more than one. `superior` = no grants at all, but
  // they are the named immediate superior on an open offboarding case, so
  // they may sign in just to clear that Reporting Unit section.
  const hasGrants = access.isSuper || access.isPayroll || access.buChoices.length > 0;
  const superior = !hasGrants && access.superiorSections > 0;
  return res.json({
    authorized: hasGrants || superior,
    is_super_admin: access.isSuper,
    is_group_payroll: access.isPayroll,
    bu_grants: access.buChoices,
    bu_roles: access.byBu,
    units: hasGrants ? await unitChoices(access) : [],
    superior,
    admin_user_id: access.adminUser ? access.adminUser.id : null,
    email: identity.email,
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
    identity = await oauthVerify.verifyMicrosoftIdToken(idToken, process.env.ADMIN_MS_CLIENT_ID);
  } catch (err) {
    return res.status(401).json({ error: `Invalid Microsoft sign-in: ${err.message}` });
  }

  const access = await resolveAdminGrants(identity.email);
  const result = await mintSession(access, identity.email, businessUnit);
  if (result.error) return res.status(result.status).json({ error: result.error });
  return res.json(result);
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
    return res.json({
      email: req.admin.email || null,
      display_name: req.admin.unitScope === 'SUPERIOR' ? (req.admin.email || 'Superior') : 'Break-glass admin',
      unit_scope: req.admin.unitScope,
      roles: req.admin.roles,
    });
  }
  const { rows } = await db.query('SELECT email, display_name FROM admin_users WHERE id = $1', [req.admin.adminUserId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Admin not found' });
  return res.json({
    email: rows[0].email,
    display_name: rows[0].display_name || rows[0].email,
    unit_scope: req.admin.unitScope,
    roles: req.admin.roles,
  });
}));

// GET /api/admin/auth/units — the units this signed-in person may switch to.
router.get('/auth/units', asyncHandler(async (req, res) => {
  if (!req.admin.email) return res.json({ current: req.admin.unitScope, units: [] });
  const access = await resolveAdminGrants(req.admin.email);
  return res.json({ current: req.admin.unitScope, units: await unitChoices(access) });
}));

// POST /api/admin/auth/switch  { business_unit }  ("Switch business unit")
// Re-reads this person's grants from the database (a revoked grant or a
// deactivated account can't be switched into) and returns a new session.
router.post('/auth/switch', asyncHandler(async (req, res) => {
  const requested = String((req.body && req.body.business_unit) || '').trim();
  if (!requested) return res.status(400).json({ error: 'business_unit is required' });
  if (!req.admin.email || req.admin.unitScope === 'SUPERIOR') {
    return res.status(403).json({ error: 'This session cannot switch business unit' });
  }
  const access = await resolveAdminGrants(req.admin.email);
  if (!access.adminUser) return res.status(403).json({ error: 'This account has no admin access' });
  const result = await mintSession(access, req.admin.email, requested);
  if (result.error) return res.status(result.status === 400 && !access.isSuper ? 403 : result.status).json({ error: result.error });
  return res.json(result);
}));

// Everything below this line is the job-application side of the dashboard:
// HR admins only. Payroll PIC, Clearance PIC and superior sessions reach
// only /me above and the offboarding router (routes/adminOffboarding.js).
router.use(requireHrAdmin);

// ============================================================================
// Dashboard / search / stats (spec §1.5 "Dashboard / search / stats")
// ============================================================================

// Onboarding progress for a hired candidate, for the dashboard's reminder
// button: 'not_started' | 'in_progress' | 'completed', and when they were
// last reminded (automatic or by hand).
const ONBOARDING_COLUMNS_SQL = `
  COALESCE((SELECT o.status FROM onboarding_records o WHERE o.application_id = applications.id), 'not_started') AS onboarding_status,
  (SELECT max(n.sent_at) FROM notification_log n
    WHERE n.ref_key = applications.id::text AND n.step > 0
      AND n.kind IN ('onboarding_reminder', 'onboarding_reminder_manual')) AS last_onboarding_reminder_at`;
// Same columns without the reminder log, used when notification_log can't be
// read (table missing, or the app's database login has no rights on it).
const ONBOARDING_COLUMNS_NO_LOG_SQL = `
  COALESCE((SELECT o.status FROM onboarding_records o WHERE o.application_id = applications.id), 'not_started') AS onboarding_status,
  NULL::timestamptz AS last_onboarding_reminder_at`;

let warnedNoLog = false;
/**
 * Run a query that includes the onboarding columns. If the reminder log
 * can't be read (42501 permission denied / 42P01 missing table), retry
 * without it so the dashboard still lists applications — only the
 * "last reminded" date is blank — and log how to fix the database once.
 */
async function queryWithOnboardingColumns(buildSql, values) {
  try {
    return await db.query(buildSql(ONBOARDING_COLUMNS_SQL), values);
  } catch (err) {
    if (!['42501', '42P01'].includes(err.code) || !/notification_log/.test(err.message || '')) throw err;
    if (!warnedNoLog) {
      warnedNoLog = true;
      // eslint-disable-next-line no-console
      console.error(`notification_log not readable (${err.message}). Run scripts/fix-db-permissions.sh on the server.`);
    }
    return db.query(buildSql(ONBOARDING_COLUMNS_NO_LOG_SQL), values);
  }
}

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
  const limitSql = `LIMIT $${i++} OFFSET $${i++}`;
  const { rows } = await queryWithOnboardingColumns(
    (cols) => `SELECT applications.*, ${cols}
       FROM applications ${whereSql} ORDER BY created_at DESC ${limitSql}`,
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
  const { rows } = await db.query(`SELECT id, name, category, business_unit FROM companies ${whereSql} ORDER BY business_unit, name`, values);
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
  if (patch.business_unit && await badBu(res, patch.business_unit)) return;

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
    const names = await businessUnits.nameMap();
    notify('bu_transfer', sanitizeNotificationPayload({
      ...updated,
      notify_email: notifyEmail,
      from_business_unit: app.business_unit || '',
      // Display names ("Property Development") for the email wording.
      business_unit_name: names[updated.business_unit] || updated.business_unit,
      from_business_unit_name: names[app.business_unit] || app.business_unit || '',
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
        AND status != 'draft'  -- drafts are the candidate's own unsent work, never shown to admins
        AND (
          (nric_new IS NOT NULL AND nric_new = $3) OR
          (passport_number IS NOT NULL AND passport_number = $4) OR
          (email IS NOT NULL AND email = $5)
        )`,
    [app.id, app.business_unit, app.nric_new, app.passport_number, app.email]
  );
  return res.json(rows);
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
// Manual onboarding reminder ("Send reminder", stakeholder feedback)
//
// Same email as the automatic 9 am reminder. At most one manual reminder per
// candidate per day (Malaysia time), logged in notification_log so the
// automatic run skips that candidate on the same day.
// ============================================================================
const MANUAL_REMINDER = 'onboarding_reminder_manual';
const todayKeyMYT = () => Number(new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, ''));

/** Send to one application row; returns { ok } or { status, error }. */
async function remindOnboarding(app) {
  if (app.status !== 'hired') return { status: 409, error: 'Only hired candidates have onboarding to complete' };
  if (!app.email) return { status: 409, error: 'This candidate has no email address' };
  const ob = await db.query('SELECT status FROM onboarding_records WHERE application_id = $1', [app.id]);
  if (ob.rows[0] && ob.rows[0].status === 'completed') return { status: 409, error: 'Onboarding is already completed' };
  const step = todayKeyMYT();
  const already = await db.query('SELECT 1 FROM notification_log WHERE kind = $1 AND ref_key = $2 AND step = $3', [MANUAL_REMINDER, app.id, step]);
  if (already.rows.length) return { status: 429, error: 'A reminder was already sent to this candidate today' };
  const unit = await businessUnits.get(app.business_unit);
  const sent = await sendOnboardingReminder(app, unit ? unit.name : app.business_unit);
  if (!sent.ok) return { status: 502, error: 'The email could not be sent (email flow not reachable). Please try again later.' };
  await db.query('INSERT INTO notification_log (kind, ref_key, step) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [MANUAL_REMINDER, app.id, step]);
  return { ok: true };
}

// POST /api/admin/applications/:id/onboarding-reminder
router.post('/applications/:id/onboarding-reminder', asyncHandler(async (req, res) => {
  const app = await fetchScopedApplication(req, res);
  if (!app) return;
  const r = await remindOnboarding(app);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const { rows } = await queryWithOnboardingColumns((cols) => `SELECT ${cols} FROM applications WHERE id = $1`, [app.id]);
  return res.json(rows[0]);
}));

// POST /api/admin/onboarding-reminders  { application_ids: [...] }  (bulk, max 100)
router.post('/onboarding-reminders', asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.application_ids) ? req.body.application_ids.slice(0, 100) : [];
  if (!ids.length) return res.status(400).json({ error: 'application_ids is required' });
  const UUID = /^[0-9a-f-]{36}$/i;
  let sent = 0;
  const skipped = [];
  for (const id of ids) {
    if (!UUID.test(String(id))) { skipped.push({ id, reason: 'Invalid id' }); continue; }
    const { rows } = await db.query("SELECT * FROM applications WHERE id = $1 AND status <> 'draft'", [id]); // eslint-disable-line no-await-in-loop
    const app = rows[0];
    if (!app || (!isSuperAdmin(req.admin) && app.business_unit !== req.admin.unitScope)) { skipped.push({ id, reason: 'Not found' }); continue; }
    const r = await remindOnboarding(app); // eslint-disable-line no-await-in-loop
    if (r.ok) sent += 1; else skipped.push({ id, reference_no: app.reference_no, reason: r.error });
  }
  return res.json({ sent, skipped });
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
    return res.status(400).json({ error: `status must be one of ${GENERIC_STATUS_OPTIONS.join(', ')}` });
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
  // 'rejected' is deliberately left out (HR decision, 15 Oct 2026): rejected
  // candidates are no longer emailed when their status changes.
  const NOTIFY_STATUSES = ['under_review', 'shortlisted', 'interview_scheduled', 'offer_sent', 'hired', 'withdrawn', 'blacklisted'];
  if (NOTIFY_STATUSES.includes(result.status)) {
    const notifyEmail = await getManagerEmail(result.business_unit);
    const names = await businessUnits.nameMap();
    notify('status_change', sanitizeNotificationPayload({
      ...result, notify_email: notifyEmail, business_unit_name: names[result.business_unit] || result.business_unit,
    }));
  }

  return res.json(result);
}));

// ============================================================================
// Business units (Business Unit Settings — migration 008)
//
// Every HR admin can read the list (for filters, transfers and company
// pickers); only a Super Admin may add, rename, deactivate or delete a unit.
// A unit's `code` is permanent once rows use it (it is in candidate links
// and on every record); its display name, reference prefix, PIC email and
// order can change at any time.
// ============================================================================

const BU_CODE_RE = /^[A-Za-z0-9&]{1,20}$/;
const REF_CODE_RE = /^[A-Z0-9]{2,8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanBuInput(body, { creating }) {
  const out = {};
  const errors = [];
  if (creating || body.name !== undefined) {
    out.name = String(body.name || '').trim();
    if (!out.name || out.name.length > 80) errors.push('name is required (max 80 characters)');
  }
  if (creating || body.ref_code !== undefined) {
    out.ref_code = String(body.ref_code || '').trim().toUpperCase();
    if (!REF_CODE_RE.test(out.ref_code)) errors.push('ref_code must be 2-8 letters or digits (used in reference numbers, e.g. WCT-HTL-2026-000001)');
  }
  if (body.pic_email !== undefined) {
    out.pic_email = String(body.pic_email || '').trim().toLowerCase() || null;
    if (out.pic_email && !out.pic_email.split(/[;,]\s*/).every((e) => EMAIL_RE.test(e))) errors.push('pic_email must be a valid email address');
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') errors.push('is_active must be true or false');
    out.is_active = body.is_active;
  }
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 10000) errors.push('sort_order must be a whole number');
    out.sort_order = n;
  }
  return { out, errors };
}

const conflictMessage = (err) => (/ref_code/.test(err.constraint || '') ? 'Another business unit already uses that reference prefix'
  : /name/.test(err.constraint || '') ? 'Another business unit already has that name' : 'That business unit code already exists');

// GET /api/admin/business-units — every unit (inactive ones too) with company counts.
router.get('/business-units', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT b.code, b.name, b.ref_code, b.pic_email, b.sort_order, b.is_active,
           (SELECT count(*)::int FROM companies c WHERE c.business_unit = b.code) AS company_count,
           (SELECT count(*)::int FROM applications a WHERE a.business_unit = b.code AND a.status <> 'draft') AS application_count
      FROM business_units b
     ORDER BY b.sort_order, b.name`);
  return res.json(rows);
}));

// POST /api/admin/business-units  { code, name, ref_code, pic_email? }
router.post('/business-units', requireSuperAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const code = String(body.code || '').trim();
  const { out, errors } = cleanBuInput(body, { creating: true });
  if (!BU_CODE_RE.test(code)) errors.unshift('code must be 1-20 letters, digits or & (it appears in the candidate link, e.g. ?bu=Hotels)');
  if (['ALL', 'GROUP', 'SUPERIOR'].includes(code.toUpperCase())) errors.unshift('That code is reserved');
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const sortOrder = out.sort_order !== undefined ? out.sort_order
    : (await db.query('SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM business_units')).rows[0].n;
  try {
    const { rows } = await db.query(
      `INSERT INTO business_units (code, name, ref_code, pic_email, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, true)) RETURNING *`,
      [code, out.name, out.ref_code, out.pic_email || null, sortOrder, out.is_active]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: conflictMessage(err) });
    throw err;
  }
}));

// PATCH /api/admin/business-units/:code  { name?, ref_code?, pic_email?, is_active?, sort_order? }
router.patch('/business-units/:code', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { out, errors } = cleanBuInput(req.body || {}, { creating: false });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const keys = Object.keys(out);
  if (keys.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  if (out.ref_code) {
    // Reference numbers already issued carry the old prefix; changing it would
    // let a later unit reuse that prefix and clash with them.
    const used = await db.query(
      `SELECT b.ref_code, (SELECT count(*)::int FROM applications a WHERE a.business_unit = b.code) AS n
         FROM business_units b WHERE b.code = $1`, [req.params.code]);
    if (used.rows[0] && used.rows[0].n > 0 && used.rows[0].ref_code !== out.ref_code) {
      return res.status(409).json({ error: 'The reference prefix cannot change once this business unit has applications' });
    }
  }
  try {
    const { rows } = await db.query(
      `UPDATE business_units SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE code = $1 RETURNING *`,
      [req.params.code, ...keys.map((k) => out[k])]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Business unit not found' });
    return res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: conflictMessage(err) });
    throw err;
  }
}));

// DELETE /api/admin/business-units/:code — only a unit nothing uses yet
// (otherwise deactivate it instead, which keeps its history).
router.delete('/business-units/:code', requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM business_units WHERE code = $1', [req.params.code]);
    if (rowCount === 0) return res.status(404).json({ error: 'Business unit not found' });
    return res.status(204).send();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'This business unit already has applications, companies, staff or cases. Deactivate it instead.' });
    }
    throw err;
  }
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
  if (await badBu(res, businessUnit)) return;
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

  // Moving a company to another business unit is for Super Admins only.
  const body = req.body || {};
  if (body.business_unit !== undefined) {
    if (!isSuperAdmin(req.admin)) return res.status(403).json({ error: 'Only an All-Units admin may move a company to another business unit' });
    if (await badBu(res, body.business_unit)) return;
  }
  const update = buildPatchUpdate('companies', 'id', req.params.id, body, ['name', 'category', 'business_unit']);
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
  if (!Array.isArray(categories)) return res.status(400).json({ error: 'categories (array) is required' });
  if (await badBu(res, unitScope)) return;

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
           g.id AS grant_id, g.role, g.business_unit, g.department_id, d.name AS department_name
      FROM admin_users au
      LEFT JOIN admin_grants g ON g.admin_user_id = au.id
      LEFT JOIN clearance_departments d ON d.id = g.department_id
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
  // Any valid work email is accepted: some admins sign in with a subsidiary
  // domain (e.g. @wctmalls.wct.my), so the old @wct.my-only rule is gone.

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
  if (role === 'clearance_pic') {
    return res.status(400).json({ error: 'Clearance PIC is no longer used: HR completes the clearance sections' });
  }
  const GRANTABLE = ['super_admin', 'bu_admin', 'payroll_pic'];
  if (!GRANTABLE.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${GRANTABLE.join(', ')}` });
  }
  // HR Admin names a unit; Super Admin never does; Payroll PIC may name one
  // or none ("all business units").
  const needsBu = role === 'bu_admin';
  const keepsBu = role !== 'super_admin';
  if (needsBu && !businessUnit) {
    return res.status(400).json({ error: `business_unit is required for a ${role} grant` });
  }
  if (businessUnit && await badBu(res, businessUnit)) return;
  if (role === 'super_admin' && businessUnit) {
    return res.status(400).json({ error: 'business_unit must not be set for a super_admin grant' });
  }
  const departmentId = null; // only Clearance PIC grants carried one

  const adminRows = await db.query('SELECT id, email, display_name FROM admin_users WHERE id = $1', [req.params.admin_user_id]);
  if (adminRows.rows.length === 0) return res.status(404).json({ error: 'Admin user not found' });
  const targetAdmin = adminRows.rows[0];

  let grant;
  try {
    const { rows } = await db.query(
      'INSERT INTO admin_grants (admin_user_id, role, business_unit, department_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.admin_user_id, role, keepsBu && businessUnit ? businessUnit : null, departmentId]
    );
    grant = rows[0];
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This person already has that role' });
    throw err;
  }

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
    role_label: formatRoleLabel(grant.role, grant.business_unit, grant.department_id),
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
    `SELECT g.role, g.business_unit, g.department_id, au.email, au.display_name
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
    role_label: formatRoleLabel(grant.role, grant.business_unit, grant.department_id),
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
    'SELECT role, business_unit, department_id FROM admin_grants WHERE admin_user_id = $1 ORDER BY role, business_unit',
    [req.params.admin_user_id]
  );
  const roleLabel = grantRows.rows.map((g) => formatRoleLabel(g.role, g.business_unit, g.department_id)).join(', ');

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
