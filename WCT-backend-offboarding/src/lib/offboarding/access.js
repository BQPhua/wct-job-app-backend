'use strict';

// ============================================================================
// Who-can-do-what for staff sessions (admin.html).
//
// Roles come from `admin_grants` and are folded into the admin JWT at session
// creation as `roles` for the chosen scope (see routes/admin.js
// /auth/session). This module is the single place that turns grants into
// session roles and answers access questions, so routes never re-derive them.
//
//   unit_scope 'ALL'       super admin — every role, every BU
//   unit_scope 'E&C'|...   BU session — roles held in THAT business unit
//   unit_scope 'SUPERIOR'  immediate superior with no grant — may only work
//                          on Reporting Unit sections assigned to their email
// ============================================================================

const db = require('../../db');

const ALL_DEPARTMENT_IDS = [1, 2, 3, 4, 5, 6];
const EMPTY_ROLES = Object.freeze({ bu_admin: false, payroll_pic: false, clearance_department_ids: [] });

/**
 * Everything an email is entitled to, straight from the database.
 * Inactive admin_users rows count as having no grants.
 */
async function resolveAdminGrants(email) {
  const lower = String(email || '').toLowerCase();
  const userRows = await db.query('SELECT id, email, is_active FROM admin_users WHERE email = $1', [lower]);
  const adminUser = userRows.rows[0] && userRows.rows[0].is_active ? userRows.rows[0] : null;
  // A deactivated admin is locked out entirely — including the "immediate
  // superior" route in, which otherwise needs no admin_users row at all.
  const deactivated = !!(userRows.rows[0] && !userRows.rows[0].is_active);

  let grants = [];
  if (adminUser) {
    const g = await db.query(
      'SELECT role, business_unit, department_id FROM admin_grants WHERE admin_user_id = $1',
      [adminUser.id]
    );
    grants = g.rows;
  }

  const byBu = {};
  for (const g of grants) {
    if (!['bu_admin', 'payroll_pic', 'clearance_pic'].includes(g.role)) continue;
    const r = byBu[g.business_unit] || (byBu[g.business_unit] = { bu_admin: false, payroll_pic: false, clearance_department_ids: [] });
    if (g.role === 'bu_admin') r.bu_admin = true;
    if (g.role === 'payroll_pic') r.payroll_pic = true;
    if (g.role === 'clearance_pic' && !r.clearance_department_ids.includes(g.department_id)) {
      r.clearance_department_ids.push(g.department_id);
    }
  }
  Object.values(byBu).forEach((r) => r.clearance_department_ids.sort((a, b) => a - b));

  const sup = await db.query(
    `SELECT count(*)::int AS n
       FROM offboarding_clearance_sections s
       JOIN offboarding_cases c ON c.id = s.case_id
      WHERE lower(s.assignee_email) = $1
        AND c.status NOT IN ('completed', 'cancelled')`,
    [lower]
  );

  return {
    adminUser,
    isSuper: grants.some((g) => g.role === 'super_admin'),
    byBu,
    buChoices: Object.keys(byBu).sort(),
    superiorSections: deactivated ? 0 : sup.rows[0].n,
    deactivated,
  };
}

/** Roles a verified JWT payload stands for (tolerates pre-roles tokens). */
function rolesFromClaims(payload) {
  if (payload.unit_scope === 'ALL') {
    return { bu_admin: true, payroll_pic: true, clearance_department_ids: ALL_DEPARTMENT_IDS.slice() };
  }
  if (payload.unit_scope === 'SUPERIOR') return { ...EMPTY_ROLES, clearance_department_ids: [] };
  if (payload.roles) {
    return {
      bu_admin: !!payload.roles.bu_admin,
      payroll_pic: !!payload.roles.payroll_pic,
      clearance_department_ids: Array.isArray(payload.roles.clearance_department_ids)
        ? payload.roles.clearance_department_ids.map(Number) : [],
    };
  }
  // Token minted before PIC roles existed: those were always bu_admin sessions.
  return { bu_admin: true, payroll_pic: false, clearance_department_ids: [] };
}

const isSuper = (admin) => admin.unitScope === 'ALL';
const isHr = (admin) => isSuper(admin) || !!(admin.roles && admin.roles.bu_admin);

/** Express guard for every job-application admin route (HR only). */
function requireHrAdmin(req, res, next) {
  if (isHr(req.admin)) return next();
  return res.status(403).json({ error: 'This page is only available to HR admins' });
}

const DEPARTMENT_NAMES = { 1: 'Reporting Unit', 2: 'IT', 3: 'Administration', 4: 'Finance', 5: 'Purchasing', 6: 'Human Resources' };

function formatRoleLabel(role, businessUnit, departmentId) {
  if (role === 'super_admin') return 'Super Admin';
  if (role === 'bu_admin') return `BU Admin (${businessUnit || 'unassigned'})`;
  if (role === 'payroll_pic') return `Payroll PIC (${businessUnit})`;
  if (role === 'clearance_pic') return `Clearance PIC — ${DEPARTMENT_NAMES[departmentId] || 'Department'} (${businessUnit})`;
  return role || '';
}

// ---------------------------------------------------------------------------
// Case-level access
// ---------------------------------------------------------------------------

const lc = (v) => (v ? String(v).toLowerCase() : '');
const inBu = (admin, bu) => isSuper(admin) || admin.unitScope === bu;

/** HR (bu_admin) for this BU, or super admin. */
const isHrFor = (admin, bu) => isSuper(admin) || (admin.unitScope === bu && !!admin.roles.bu_admin);
/** Payroll PIC for this BU, or super admin. */
const isPayrollFor = (admin, bu) => isSuper(admin) || (admin.unitScope === bu && !!admin.roles.payroll_pic);

/**
 * SQL predicate (for a WHERE clause on offboarding_cases aliased `alias`)
 * limiting rows to the cases this session may see. Placeholders start at
 * $startIndex; returns { sql, values }.
 *
 *  - super admin: everything
 *  - HR / payroll PIC: every case in their BU
 *  - clearance PIC: cases in their BU that have a section of their department
 *  - anyone: cases whose Reporting Unit section is assigned to their email
 */
function caseScopeSql(admin, alias = 'c', startIndex = 1) {
  if (isSuper(admin)) return { sql: 'TRUE', values: [] };
  const values = [];
  const p = (v) => { values.push(v); return `$${startIndex + values.length - 1}`; };
  const parts = [];
  const email = lc(admin.email);
  if (email) {
    parts.push(`EXISTS (SELECT 1 FROM offboarding_clearance_sections sx
                         WHERE sx.case_id = ${alias}.id AND lower(sx.assignee_email) = ${p(email)})`);
  }
  if (admin.unitScope !== 'SUPERIOR') {
    const r = admin.roles || {};
    if (r.bu_admin || r.payroll_pic) {
      parts.push(`${alias}.business_unit = ${p(admin.unitScope)}`);
    } else if (r.clearance_department_ids && r.clearance_department_ids.length) {
      parts.push(`(${alias}.business_unit = ${p(admin.unitScope)} AND EXISTS (
                    SELECT 1 FROM offboarding_clearance_sections sd
                     WHERE sd.case_id = ${alias}.id AND sd.department_id = ANY(${p(r.clearance_department_ids)}::int[])))`);
    }
  }
  if (parts.length === 0) return { sql: 'FALSE', values: [] };
  return { sql: `(${parts.join(' OR ')})`, values };
}

/** JS twin of caseScopeSql for a loaded case + its sections. */
function canViewCase(admin, caseRow, sections = []) {
  if (isSuper(admin)) return true;
  const email = lc(admin.email);
  if (email && sections.some((s) => lc(s.assignee_email) === email)) return true;
  if (admin.unitScope === 'SUPERIOR' || admin.unitScope !== caseRow.business_unit) return false;
  const r = admin.roles || {};
  if (r.bu_admin || r.payroll_pic) return true;
  const depts = r.clearance_department_ids || [];
  return sections.some((s) => depts.includes(s.department_id));
}

/**
 * Is this session the rightful signer of the section (not on behalf)?
 * Reporting Unit: the assigned superior if one is set, otherwise that BU's
 * Reporting Unit PICs. Other departments: that BU's PICs for the department.
 */
function isSectionOwner(admin, caseRow, section) {
  const email = lc(admin.email);
  if (section.assignee_email) return email !== '' && lc(section.assignee_email) === email;
  if (admin.unitScope === 'SUPERIOR' || !inBu(admin, caseRow.business_unit)) return false;
  if (isSuper(admin)) return false; // super admins act on behalf, never as the PIC
  return (admin.roles.clearance_department_ids || []).includes(section.department_id);
}

/**
 * May this session save / sign `section`? Returns { ok: true, onBehalf } or
 * { ok: false, reason } with reason one of:
 *   'status'    case isn't in clearance
 *   'own_case'  nobody clears their own offboarding
 *   'not_owner' not this person's section (HR must pass { onBehalf: true })
 */
function canEditSection(admin, caseRow, section, { onBehalf = false } = {}) {
  if (caseRow.status !== 'clearance_in_progress') return { ok: false, reason: 'status' };
  if (lc(admin.email) && lc(admin.email) === lc(caseRow.employee_email)) return { ok: false, reason: 'own_case' };
  if (isSectionOwner(admin, caseRow, section)) return { ok: true, onBehalf: false };
  if (onBehalf && isHrFor(admin, caseRow.business_unit)) return { ok: true, onBehalf: true };
  return { ok: false, reason: 'not_owner' };
}

module.exports = {
  caseScopeSql,
  canViewCase,
  canEditSection,
  isSectionOwner,
  isHrFor,
  isPayrollFor,
  ALL_DEPARTMENT_IDS,
  DEPARTMENT_NAMES,
  resolveAdminGrants,
  rolesFromClaims,
  isSuper,
  isHr,
  requireHrAdmin,
  formatRoleLabel,
};
