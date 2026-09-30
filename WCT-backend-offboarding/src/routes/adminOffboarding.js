'use strict';

// ============================================================================
// Staff-side offboarding API — /api/admin/offboarding
// (spec: docs/superpowers/specs/2026-09-30-offboarding-merge-design.md §5)
//
// Used by HR (bu_admin / super admin), Payroll PICs, Clearance PICs and
// immediate superiors, all signed in through admin.html. Every route:
//   1. resolves the case through access.caseScopeSql / canViewCase, so a
//      case outside the session's reach is a 404 (its existence is not
//      revealed across business units);
//   2. checks the role for the action (403 when visible but not allowed);
//   3. runs state changes in one transaction with the case row locked;
//   4. sends email AFTER commit (a Power Automate hiccup never rolls back
//      or fails the action — it's recorded on the timeline instead).
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireAdminAuth } = require('../middleware/auth');
const access = require('../lib/offboarding/access');
const lifecycle = require('../lib/offboarding/lifecycle');
const mailer = require('../lib/offboarding/mailer');
const pdf = require('../lib/offboarding/pdf');
const dates = require('../lib/offboarding/dates');
const { STATUSES, STATUS_LABELS, OPEN_STATUSES, EXIT_REASONS, TOTAL_SECTIONS } = require('../lib/offboarding/constants');

const router = express.Router();
router.use(requireAdminAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A malformed case id can only ever be "not found" (never a raw Postgres error).
router.param('id', (req, res, next, id) => (UUID_RE.test(id) ? next() : res.status(404).json({ error: 'Case not found' })));

const BUSINESS_UNITS = ['E&C', 'Land', 'Mall'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const lc = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const clean = (v) => { if (v == null) return null; const s = String(v).trim(); return s === '' ? null : s; };
const frontend = () => process.env.FRONTEND_BASE_URL || 'https://bqphua.github.io/job-app';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// Wrap handlers so HttpError becomes a JSON response with its status.
const handle = (fn) => asyncHandler(async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

function requireHr(req) {
  if (!access.isHr(req.admin)) fail(403, 'Only HR admins can do this');
}

/** Nobody manages (edits, cancels, signs off, pays) their own offboarding. */
function requireNotOwnCase(req, caseRow) {
  if (lc(req.admin.email) && lc(req.admin.email) === lc(caseRow.employee_email)) {
    fail(403, "You can't manage your own offboarding case — please ask another HR admin");
  }
}

/** Load a case the session may see, or 404. Returns the bundle. */
async function visibleBundle(req, q = db) {
  const bundle = await lifecycle.loadBundle(q, req.params.id);
  if (!bundle || !access.canViewCase(req.admin, bundle.case, bundle.sections)) fail(404, 'Case not found');
  return bundle;
}

/** Lock + load inside a transaction, enforcing visibility. */
async function lockedBundle(client, req) {
  const row = await lifecycle.lockCase(client, req.params.id);
  if (!row) fail(404, 'Case not found');
  const bundle = await lifecycle.loadBundle(client, req.params.id);
  if (!access.canViewCase(req.admin, bundle.case, bundle.sections)) fail(404, 'Case not found');
  return bundle;
}

const effectiveLastDay = (c) => c.actual_last_day || c.official_last_day || null;

function waitingOn(row, pendingDepartments) {
  switch (row.status) {
    case 'invited': return 'Employee — Exit Interview';
    case 'clearance_in_progress': return pendingDepartments && pendingDepartments.length ? pendingDepartments.join(', ') : 'Clearance';
    case 'pending_acknowledgement': return 'Employee — Acknowledgement';
    case 'pending_payroll': return 'Payroll';
    default: return '—';
  }
}

/** Response shape for a case bundle, with what THIS session may do. */
function present(req, bundle) {
  const c = bundle.case;
  const a = req.admin;
  const hr = access.isHrFor(a, c.business_unit);
  const open = OPEN_STATUSES.includes(c.status);
  const submitted = !!(bundle.exitInterview && bundle.exitInterview.employee_signed_at);
  // The Exit Interview (reasons, comments) is confidential to HR — Payroll
  // also receives it as a PDF. Clearance PICs and the immediate superior
  // only ever see the checklists.
  const canReadInterview = hr || access.isPayrollFor(a, c.business_unit);
  const { invite_token: token, ...caseOut } = c;
  const out = {
    case: {
      ...caseOut,
      effective_last_day: effectiveLastDay(c),
      status_label: STATUS_LABELS[c.status],
      sections_signed: bundle.sections.filter((s) => s.status === 'complete').length,
      sections_total: TOTAL_SECTIONS,
    },
    exitInterview: canReadInterview ? bundle.exitInterview : null,
    exit_interview_submitted: submitted,
    sections: bundle.sections.map((s) => {
      const own = access.canEditSection(a, c, s);
      const behalf = !own.ok && access.canEditSection(a, c, s, { onBehalf: true });
      return {
        ...s,
        can_edit: own.ok,
        can_sign_on_behalf: !!(behalf && behalf.ok),
        can_reopen: hr && s.status === 'complete' && ['clearance_in_progress', 'pending_acknowledgement', 'pending_payroll'].includes(c.status),
      };
    }),
    events: bundle.events,
    can: {
      edit_details: hr && open,
      resend_invite: hr && c.status === 'invited',
      cancel: hr && open,
      remind: hr && c.status === 'clearance_in_progress',
      hr_signoff: hr && submitted && !['cancelled', 'completed'].includes(c.status),
      view_exit_interview: canReadInterview,
      payroll_done: access.isPayrollFor(a, c.business_unit) && c.status === 'pending_payroll',
      pdf_exit_interview: submitted && canReadInterview,
      pdf_clearance: ['pending_payroll', 'completed'].includes(c.status),
    },
  };
  if (hr) out.invite_link = `${frontend()}/index.html?offboard=${encodeURIComponent(token)}`;
  return out;
}

async function afterCommitEmail(caseId, actor, eventType, extra = {}) {
  const bundle = await lifecycle.loadBundle(db, caseId);
  const result = await mailer.send(eventType, bundle, extra);
  if (!result.ok) {
    await lifecycle.logEvent(db, caseId, actor, 'email_failed', { email: eventType, error: result.error || null });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
router.get('/meta', handle(async (req, res) => {
  const a = req.admin;
  const [depts, companies] = await Promise.all([
    db.query('SELECT id, name, is_reporting_unit FROM clearance_departments ORDER BY display_order'),
    db.query(
      `SELECT name, business_unit FROM companies ${access.isSuper(a) ? '' : 'WHERE business_unit = $1'} ORDER BY name`,
      access.isSuper(a) ? [] : [a.unitScope]
    ),
  ]);
  res.json({
    departments: depts.rows,
    reasons: EXIT_REASONS,
    statuses: STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    roles: a.roles,
    unit_scope: a.unitScope,
    email: a.email,
    is_hr: access.isHr(a),
    business_units: access.isSuper(a) ? BUSINESS_UNITS : (BUSINESS_UNITS.includes(a.unitScope) ? [a.unitScope] : []),
    companies: a.unitScope === 'SUPERIOR' ? [] : companies.rows,
    today: dates.todayMYT(),
  });
}));

// Pre-fill the invite form from the newest hired application with that email.
router.get('/prefill', handle(async (req, res) => {
  requireHr(req);
  const email = lc(req.query.email);
  if (!EMAIL_RE.test(email)) fail(400, 'A valid email is required');
  const buClause = access.isSuper(req.admin) ? '' : 'AND a.business_unit = $2';
  const values = access.isSuper(req.admin) ? [email] : [email, req.admin.unitScope];
  const { rows } = await db.query(
    `SELECT a.id, a.name_nric, a.position_applying, a.business_unit, co.name AS company_name
       FROM applications a
       LEFT JOIN companies co ON co.id = a.company_id
      WHERE lower(a.email) = $1 AND a.status = 'hired' ${buClause}
      ORDER BY a.updated_at DESC LIMIT 1`,
    values
  );
  const openRows = await db.query(
    `SELECT id, ref_no, status, business_unit FROM offboarding_cases
      WHERE lower(employee_email) = $1 AND status NOT IN ('completed', 'cancelled') LIMIT 1`,
    [email]
  );
  const o = openRows.rows[0];
  // Only reveal the case itself if it's in this session's business unit.
  const openCase = !o ? null : (access.isHrFor(req.admin, o.business_unit)
    ? { id: o.id, ref_no: o.ref_no, status: o.status }
    : { ref_no: o.ref_no, other_business_unit: true });
  const a = rows[0];
  res.json({
    ...(a ? {
      application_id: a.id,
      employee_name: a.name_nric,
      position: a.position_applying,
      business_unit: a.business_unit,
      company_name: a.company_name,
    } : {}),
    open_case: openCase,
  });
}));

// ---------------------------------------------------------------------------
// List / counts / export
// ---------------------------------------------------------------------------
const SORTS = {
  last_day: 'COALESCE(c.actual_last_day, c.official_last_day)',
  created: 'c.created_at',
  name: 'lower(c.employee_name)',
  status: `array_position(ARRAY['invited','clearance_in_progress','pending_acknowledgement','pending_payroll','completed','cancelled'], c.status)`,
  ref: 'c.ref_no',
};

/** Predicate for "cases waiting on me" (sections I own, or payroll work). */
function mineSql(a, push) {
  const email = lc(a.email);
  const parts = [];
  if (a.unitScope !== 'SUPERIOR') {
    const depts = a.roles.clearance_department_ids || [];
    if (depts.length && !access.isSuper(a)) {
      parts.push(`EXISTS (SELECT 1 FROM offboarding_clearance_sections sm
                  WHERE sm.case_id = c.id AND sm.status = 'pending' AND sm.assignee_email IS NULL
                    AND sm.department_id = ANY(${push(depts)}::int[]) AND c.business_unit = ${push(a.unitScope)})`);
    }
    if (a.roles.payroll_pic) {
      parts.push(access.isSuper(a) ? "c.status = 'pending_payroll'"
        : `(c.status = 'pending_payroll' AND c.business_unit = ${push(a.unitScope)})`);
    }
  }
  if (email) {
    parts.push(`EXISTS (SELECT 1 FROM offboarding_clearance_sections sa
                WHERE sa.case_id = c.id AND sa.status = 'pending' AND lower(sa.assignee_email) = ${push(email)})`);
  }
  if (!parts.length) return 'FALSE';
  const own = email ? ` AND lower(c.employee_email) <> ${push(email)}` : '';
  return `((${parts.join(' OR ')})${own} AND c.status IN ('clearance_in_progress', 'pending_payroll'))`;
}

function buildListQuery(req) {
  const a = req.admin;
  const q = req.query;
  const scope = access.caseScopeSql(a, 'c', 1);
  const values = [...scope.values];
  const push = (v) => { values.push(v); return `$${values.length}`; };
  const where = [scope.sql];
  const today = dates.todayMYT();

  if (access.isSuper(a) && BUSINESS_UNITS.includes(q.business_unit)) where.push(`c.business_unit = ${push(q.business_unit)}`);
  // The summary tiles count everything in scope (+ super admin BU filter),
  // ignoring the other filters, so they only use the placeholders so far.
  const scopeWhere = [...where];
  const scopeValueCount = values.length;

  if (q.q) {
    const like = push(`%${String(q.q).trim().toLowerCase()}%`);
    where.push(`(lower(c.employee_name) LIKE ${like} OR lower(c.employee_email) LIKE ${like} OR lower(c.ref_no) LIKE ${like}
      OR lower(COALESCE(c.position, '')) LIKE ${like} OR lower(COALESCE(c.department, '')) LIKE ${like}
      OR lower(COALESCE(c.company_name, '')) LIKE ${like})`);
  }
  if (q.status) {
    const list = String(q.status).split(',').filter((s) => STATUSES.includes(s));
    if (list.length) where.push(`c.status = ANY(${push(list)}::text[])`);
  }
  if (q.department) where.push(`lower(COALESCE(c.department, '')) = ${push(lc(q.department))}`);
  if (q.company) where.push(`c.company_name = ${push(String(q.company))}`);
  if (q.clearance_department_id && /^[1-6]$/.test(String(q.clearance_department_id))) {
    where.push(`EXISTS (SELECT 1 FROM offboarding_clearance_sections sp WHERE sp.case_id = c.id AND sp.status = 'pending'
                 AND sp.department_id = ${push(Number(q.clearance_department_id))})`);
  }
  if (dates.isIsoDate(q.last_day_from)) where.push(`COALESCE(c.actual_last_day, c.official_last_day) >= ${push(q.last_day_from)}`);
  if (dates.isIsoDate(q.last_day_to)) where.push(`COALESCE(c.actual_last_day, c.official_last_day) <= ${push(q.last_day_to)}`);
  if (q.due === 'overdue') {
    where.push(`COALESCE(c.actual_last_day, c.official_last_day) < ${push(today)} AND c.status NOT IN ('completed','cancelled')`);
  } else if (q.due === '7d') {
    where.push(`COALESCE(c.actual_last_day, c.official_last_day) BETWEEN ${push(today)} AND ${push(dates.addDays(today, 7))}
                AND c.status NOT IN ('completed','cancelled')`);
  }
  if (q.mine === '1' || q.mine === 'true') where.push(mineSql(a, push));

  return { where, scopeWhere, scopeValueCount, values, today };
}

async function listCases(req, { all = false } = {}) {
  const { where, scopeWhere, scopeValueCount, values, today } = buildListQuery(req);
  const sortKey = SORTS[req.query.sort] ? req.query.sort : 'last_day';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.page_size, 10) || 25));

  const base = `FROM offboarding_cases c WHERE ${where.join(' AND ')}`;
  const limit = all ? '' : `LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  const rowsQ = db.query(
    `SELECT c.*, COALESCE(c.actual_last_day, c.official_last_day) AS effective_last_day,
            (SELECT count(*) FROM offboarding_clearance_sections s WHERE s.case_id = c.id AND s.status = 'complete')::int AS sections_signed,
            (SELECT array_agg(d.name ORDER BY d.display_order) FROM offboarding_clearance_sections s
               JOIN clearance_departments d ON d.id = s.department_id
              WHERE s.case_id = c.id AND s.status = 'pending') AS pending_departments,
            count(*) OVER () ::int AS total_count
       ${base}
      ORDER BY (c.status IN ('completed','cancelled')), ${SORTS[sortKey]} ${dir} NULLS LAST, c.created_at DESC
      ${limit}`,
    values
  );

  // Tile counts, in scope only.
  const cValues = values.slice(0, scopeValueCount);
  const cPush = (v) => { cValues.push(v); return `$${cValues.length}`; };
  const monthStart = `${today.slice(0, 7)}-01`;
  const mine = mineSql(req.admin, cPush);
  const countsQ = db.query(
    `SELECT
        count(*) FILTER (WHERE c.status = 'invited')::int AS invited,
        count(*) FILTER (WHERE c.status = 'clearance_in_progress')::int AS clearance_in_progress,
        count(*) FILTER (WHERE c.status = 'pending_acknowledgement')::int AS pending_acknowledgement,
        count(*) FILTER (WHERE c.status = 'pending_payroll')::int AS pending_payroll,
        count(*) FILTER (WHERE c.status = 'completed' AND (c.payroll_completed_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= ${cPush(monthStart)})::int AS completed_this_month,
        count(*) FILTER (WHERE c.status NOT IN ('completed','cancelled') AND COALESCE(c.actual_last_day, c.official_last_day) < ${cPush(today)})::int AS overdue,
        count(*) FILTER (WHERE c.status NOT IN ('completed','cancelled') AND COALESCE(c.actual_last_day, c.official_last_day) BETWEEN ${cPush(today)} AND ${cPush(dates.addDays(today, 7))})::int AS due_7d,
        count(*) FILTER (WHERE ${mine})::int AS mine
       FROM offboarding_cases c WHERE ${scopeWhere.join(' AND ')}`,
    cValues
  );
  const [rows, counts] = await Promise.all([rowsQ, countsQ]);
  return {
    total: rows.rows[0] ? rows.rows[0].total_count : 0,
    page,
    page_size: pageSize,
    counts: counts.rows[0],
    rows: rows.rows.map((r) => {
      const eff = r.effective_last_day;
      const open = OPEN_STATUSES.includes(r.status);
      const { invite_token: _t, total_count: _n, pending_departments: pend, ...rest } = r;
      return {
        ...rest,
        status_label: STATUS_LABELS[r.status],
        sections_total: TOTAL_SECTIONS,
        pending_departments: pend || [],
        waiting_on: waitingOn(r, pend),
        overdue: !!(open && eff && eff < today),
        due_soon: !!(open && eff && eff >= today && eff <= dates.addDays(today, 7)),
        days_left: eff ? dates.daysBetween(today, eff) : null,
      };
    }),
  };
}

router.get('/cases', handle(async (req, res) => {
  res.json(await listCases(req));
}));

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

router.get('/cases/export.csv', handle(async (req, res) => {
  if (!access.isHr(req.admin) && !req.admin.roles.payroll_pic) fail(403, 'Only HR and Payroll can export');
  const data = await listCases(req, { all: true });
  const header = ['Reference', 'Employee', 'Email', 'Business unit', 'Company', 'Department', 'Position', 'Date joined',
    'Official last day', 'Actual last day', 'Status', 'Sections signed', 'Waiting on', 'Invited at', 'Submitted at',
    'Acknowledged at', 'Payroll completed at', 'Cancel reason'];
  const lines = [header.join(',')].concat(data.rows.map((r) => [
    r.ref_no, r.employee_name, r.employee_email, r.business_unit, r.company_name, r.department, r.position, r.date_joined,
    r.official_last_day, r.actual_last_day, r.status_label, `${r.sections_signed}/${TOTAL_SECTIONS}`, r.waiting_on,
    r.invited_at && new Date(r.invited_at).toISOString(), r.submitted_at && new Date(r.submitted_at).toISOString(),
    r.acknowledged_at && new Date(r.acknowledged_at).toISOString(),
    r.payroll_completed_at && new Date(r.payroll_completed_at).toISOString(), r.cancel_reason,
  ].map(csvCell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="offboarding-${dates.todayMYT()}.csv"`);
  res.send(`﻿${lines.join('\n')}\n`);
}));

// ---------------------------------------------------------------------------
// Invite / detail / edit
// ---------------------------------------------------------------------------
const EDITABLE = ['employee_name', 'company_name', 'department', 'position', 'date_joined', 'immediate_superior_name',
  'immediate_superior_email', 'notice_period_days', 'official_last_day', 'actual_last_day'];

function validateDetails(input, { creating }) {
  const out = {};
  for (const k of EDITABLE) {
    if (!(k in input)) continue;
    let v = clean(input[k]);
    if (k === 'immediate_superior_email' && v) {
      v = v.toLowerCase();
      if (!EMAIL_RE.test(v)) fail(400, 'Immediate superior email is not a valid email address');
    }
    if (['date_joined', 'official_last_day', 'actual_last_day'].includes(k) && v && !dates.isIsoDate(v)) fail(400, `${k} must be a date (YYYY-MM-DD)`);
    if (k === 'notice_period_days' && v != null) {
      v = Number(v);
      if (!Number.isInteger(v) || v < 0) fail(400, 'Notice period must be a whole number of days');
    }
    out[k] = v;
  }
  if (creating && !out.employee_name) fail(400, 'Employee name is required');
  if ('employee_name' in out && !out.employee_name) fail(400, 'Employee name is required');
  return out;
}

router.post('/cases', handle(async (req, res) => {
  requireHr(req);
  const body = req.body || {};
  const email = lc(body.employee_email);
  if (!EMAIL_RE.test(email)) fail(400, 'A valid employee email is required');
  const bu = access.isSuper(req.admin) ? body.business_unit : (body.business_unit || req.admin.unitScope);
  if (!BUSINESS_UNITS.includes(bu)) fail(400, 'Business unit is required');
  if (!access.isHrFor(req.admin, bu)) fail(403, 'You can only invite people in your own business unit');
  const details = validateDetails(body, { creating: true });
  if (details.immediate_superior_email && details.immediate_superior_email === email) {
    fail(400, "The immediate superior can't be the employee themselves");
  }

  const created = await db.withTransaction(async (client) => {
    // Serialise invites for the same email so two HR clicks can't both pass the check.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`offboard:${email}`]);
    const open = await client.query(
      "SELECT ref_no FROM offboarding_cases WHERE lower(employee_email) = $1 AND status NOT IN ('completed','cancelled')",
      [email]
    );
    if (open.rows.length) fail(409, `${email} already has an open offboarding case (${open.rows[0].ref_no})`);

    let applicationId = null;
    const apps = await client.query(
      `SELECT id FROM applications WHERE lower(email) = $1 AND business_unit = $2 AND status = 'hired'
        ORDER BY updated_at DESC LIMIT 1`,
      [email, bu]
    );
    if (body.application_id && apps.rows[0] && apps.rows[0].id === body.application_id) applicationId = body.application_id;
    else if (apps.rows[0]) applicationId = apps.rows[0].id;

    const cols = ['ref_no', 'invite_token', 'employee_email', 'business_unit', 'application_id', 'invited_by_email', ...Object.keys(details)];
    const vals = [await lifecycle.nextRefNo(client), crypto.randomBytes(32).toString('hex'), email, bu, applicationId,
      lc(req.admin.email) || 'admin', ...Object.values(details)];
    const { rows } = await client.query(
      `INSERT INTO offboarding_cases (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      vals
    );
    await client.query('INSERT INTO offboarding_exit_interviews (case_id) VALUES ($1)', [rows[0].id]);
    await lifecycle.logEvent(client, rows[0].id, req.admin, 'invited', { email });
    return rows[0];
  });

  const mail = await afterCommitEmail(created.id, req.admin, 'invite');
  const bundle = await lifecycle.loadBundle(db, created.id);
  res.status(201).json({ ...present(req, bundle), email_sent: mail.ok });
}));

router.get('/cases/:id', handle(async (req, res) => {
  res.json(present(req, await visibleBundle(req)));
}));

router.patch('/cases/:id', handle(async (req, res) => {
  const body = req.body || {};
  let notifyNewSuperior = false;
  await db.withTransaction(async (client) => {
    const b = await lockedBundle(client, req);
    if (!access.isHrFor(req.admin, b.case.business_unit)) fail(403, 'Only HR can edit case details');
    requireNotOwnCase(req, b.case);
    if (!OPEN_STATUSES.includes(b.case.status)) fail(409, 'Closed cases can no longer be edited');
    const details = validateDetails(body, { creating: false });

    if (body.employee_email !== undefined && lc(body.employee_email) !== b.case.employee_email) {
      if (b.case.status !== 'invited' || b.case.employee_user_id) fail(409, 'The email can only change before the employee opens the invite');
      const email = lc(body.employee_email);
      if (!EMAIL_RE.test(email)) fail(400, 'A valid employee email is required');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`offboard:${email}`]);
      const clash = await client.query(
        "SELECT ref_no FROM offboarding_cases WHERE lower(employee_email) = $1 AND id <> $2 AND status NOT IN ('completed','cancelled')",
        [email, b.case.id]
      );
      if (clash.rows.length) fail(409, `${email} already has an open offboarding case (${clash.rows[0].ref_no})`);
      details.employee_email = email;
      details.invite_token = crypto.randomBytes(32).toString('hex');
    }
    const empEmail = details.employee_email || b.case.employee_email;
    if (details.immediate_superior_email && details.immediate_superior_email === empEmail) {
      fail(400, "The immediate superior can't be the employee themselves");
    }
    const keys = Object.keys(details);
    if (keys.length) {
      await client.query(
        `UPDATE offboarding_cases SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [b.case.id, ...keys.map((k) => details[k])]
      );
      const ru = b.sections.find((x) => x.department_id === 1);
      if ('immediate_superior_email' in details && ru && ru.status === 'pending'
          && lc(ru.assignee_email) !== lc(details.immediate_superior_email)) {
        await client.query(
          'UPDATE offboarding_clearance_sections SET assignee_email = $2 WHERE id = $1',
          [ru.id, details.immediate_superior_email]
        );
        // Whoever signs the Reporting Unit now hasn't had the task email or
        // its reminders yet — start them from scratch.
        await client.query('DELETE FROM offboarding_reminder_log WHERE case_id = $1 AND department_id = 1', [b.case.id]);
        notifyNewSuperior = b.case.status === 'clearance_in_progress';
      }
      const changed = keys.filter((k) => k !== 'invite_token');
      await lifecycle.logEvent(client, b.case.id, req.admin, 'details_updated', { fields: changed });
    }
  });
  if (notifyNewSuperior) await afterCommitEmail(req.params.id, req.admin, 'clearance_task', { departmentIds: [1] });
  res.json(present(req, await visibleBundle(req)));
}));

router.post('/cases/:id/resend-invite', handle(async (req, res) => {
  await db.withTransaction(async (client) => {
    const b = await lockedBundle(client, req);
    if (!access.isHrFor(req.admin, b.case.business_unit)) fail(403, 'Only HR can resend invites');
    if (b.case.status !== 'invited') fail(409, 'The invite can only be resent before the Exit Interview is submitted');
    await lifecycle.logEvent(client, b.case.id, req.admin, 'invite_resent', {});
  });
  const mail = await afterCommitEmail(req.params.id, req.admin, 'invite_resent');
  res.json({ ...present(req, await visibleBundle(req)), email_sent: mail.ok });
}));

router.post('/cases/:id/cancel', handle(async (req, res) => {
  const reason = clean(req.body && req.body.reason);
  if (!reason) fail(400, 'Please give a reason for cancelling');
  await db.withTransaction(async (client) => {
    const b = await lockedBundle(client, req);
    if (!access.isHrFor(req.admin, b.case.business_unit)) fail(403, 'Only HR can cancel a case');
    requireNotOwnCase(req, b.case);
    if (!OPEN_STATUSES.includes(b.case.status)) fail(409, 'This case is already closed');
    await client.query(
      `UPDATE offboarding_cases SET status = 'cancelled', cancelled_at = now(), cancelled_by_email = $2, cancel_reason = $3
        WHERE id = $1`,
      [b.case.id, lc(req.admin.email) || 'admin', reason]
    );
    await lifecycle.logEvent(client, b.case.id, req.admin, 'cancelled', { reason, previous_status: b.case.status });
  });
  await afterCommitEmail(req.params.id, req.admin, 'cancelled');
  res.json(present(req, await visibleBundle(req)));
}));

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------
async function remindCase(req, caseId, departmentIds) {
  const bundle = await lifecycle.loadBundle(db, caseId);
  if (!bundle || !access.canViewCase(req.admin, bundle.case, bundle.sections)) return null;
  if (!access.isHrFor(req.admin, bundle.case.business_unit)) fail(403, 'Only HR can send reminders');
  if (bundle.case.status !== 'clearance_in_progress') return { sent: 0, skipped: true };
  const eff = effectiveLastDay(bundle.case);
  const daysLeft = eff ? dates.daysBetween(dates.todayMYT(), eff) : null;
  const r = await mailer.send('reminder', bundle, { departmentIds, daysLeft: daysLeft != null && daysLeft >= 0 ? daysLeft : null });
  const okIds = r.results.filter((x) => x.ok).map((x) => x.department_id);
  if (okIds.length) {
    await db.query(
      'UPDATE offboarding_clearance_sections SET last_reminded_at = now() WHERE case_id = $1 AND department_id = ANY($2::int[])',
      [caseId, okIds]
    );
  }
  await lifecycle.logEvent(db, caseId, req.admin, 'reminder_sent', {
    manual: true, departments: r.results.map((x) => x.department_id), failed: r.results.filter((x) => !x.ok).map((x) => x.department_id),
  });
  return { sent: okIds.length, failed: r.results.length - okIds.length };
}

router.post('/cases/:id/remind', handle(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.department_ids) ? req.body.department_ids.map(Number) : undefined;
  const r = await remindCase(req, req.params.id, ids);
  if (!r) fail(404, 'Case not found');
  if (r.skipped) fail(409, 'Reminders can only be sent while clearance is in progress');
  res.json(r);
}));

router.post('/cases/remind-bulk', handle(async (req, res) => {
  requireHr(req);
  // Capped and sent a few cases at a time, so one click can't run past the
  // App Service request timeout.
  const ids = (Array.isArray(req.body && req.body.case_ids) ? req.body.case_ids : [])
    .filter((id) => UUID_RE.test(String(id))).slice(0, 50);
  let cases = 0;
  let sent = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += 5) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await Promise.all(ids.slice(i, i + 5).map((id) => remindCase(req, id).catch(() => null)));
    for (const r of batch) {
      if (!r || r.skipped) { skipped += 1; continue; }
      cases += 1;
      sent += r.sent;
    }
  }
  res.json({ cases, sent, skipped, limited: (req.body.case_ids || []).length > 50 });
}));

// ---------------------------------------------------------------------------
// Clearance sections
// ---------------------------------------------------------------------------
const REASON_MESSAGES = {
  status: 'This checklist can no longer be changed at this stage',
  own_case: "You can't clear your own offboarding case",
  not_owner: "This checklist isn't assigned to you",
};

router.put('/cases/:id/sections/:deptId', handle(async (req, res) => {
  const deptId = Number(req.params.deptId);
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  const signName = body.sign ? clean(body.sign.name) : null;
  if (body.sign && !signName) fail(400, 'Type your full name to sign');

  let becameReady = false;
  await db.withTransaction(async (client) => {
    const b = await lockedBundle(client, req);
    const section = b.sections.find((s) => s.department_id === deptId);
    if (!section) fail(404, 'This case has no such clearance section');
    if (section.status === 'complete' && b.case.status === 'clearance_in_progress') fail(409, 'This section is already signed. Ask HR to reopen it if something changed.');
    const allowed = access.canEditSection(req.admin, b.case, section, { onBehalf: !!body.on_behalf });
    if (!allowed.ok) fail(allowed.reason === 'status' ? 409 : 403, REASON_MESSAGES[allowed.reason]);

    const byId = new Map(section.items.map((i) => [i.id, i]));
    for (const it of items) {
      if (!byId.has(it.id)) continue; // ignore ids from other sections
      const cur = byId.get(it.id);
      await client.query(
        `UPDATE offboarding_clearance_items SET is_checked = $2, remarks = $3, custom_text = $4 WHERE id = $1`,
        [it.id, it.is_checked === undefined ? cur.is_checked : !!it.is_checked,
          it.remarks === undefined ? cur.remarks : clean(it.remarks),
          cur.is_other ? (it.custom_text === undefined ? cur.custom_text : clean(it.custom_text)) : null]
      );
    }
    if (signName) {
      await client.query(
        `UPDATE offboarding_clearance_sections
            SET status = 'complete', signed_by_email = $2, signed_by_name = $3, signed_at = now(), signed_on_behalf = $4
          WHERE id = $1`,
        [section.id, lc(req.admin.email) || null, signName, allowed.onBehalf]
      );
      await lifecycle.logEvent(client, b.case.id, req.admin, 'section_signed', {
        department_id: deptId, department: section.department_name, on_behalf: allowed.onBehalf, name: signName,
      });
      const r = await lifecycle.recalculate(client, b.case.id);
      becameReady = r.changed;
    } else {
      await lifecycle.logEvent(client, b.case.id, req.admin, 'section_saved', { department_id: deptId, department: section.department_name });
    }
  });
  if (becameReady) await afterCommitEmail(req.params.id, req.admin, 'ready_to_ack');
  res.json(present(req, await visibleBundle(req)));
}));

router.post('/cases/:id/sections/:deptId/reopen', handle(async (req, res) => {
  const deptId = Number(req.params.deptId);
  let followUp = null;
  await db.withTransaction(async (client) => {
    const b = await lockedBundle(client, req);
    if (!access.isHrFor(req.admin, b.case.business_unit)) fail(403, 'Only HR can reopen a signed section');
    requireNotOwnCase(req, b.case);
    if (!['clearance_in_progress', 'pending_acknowledgement', 'pending_payroll'].includes(b.case.status)) {
      fail(409, 'Sections can only be reopened before payroll is done');
    }
    const section = b.sections.find((s) => s.department_id === deptId);
    if (!section) fail(404, 'This case has no such clearance section');
    if (section.status !== 'complete') fail(409, 'This section is not signed yet');
    await client.query(
      `UPDATE offboarding_clearance_sections
          SET status = 'pending', signed_by_email = NULL, signed_by_name = NULL, signed_at = NULL, signed_on_behalf = false
        WHERE id = $1`,
      [section.id]
    );
    await client.query(
      `UPDATE offboarding_cases SET status = 'clearance_in_progress', acknowledged_at = NULL, acknowledged_signature_name = NULL
        WHERE id = $1`,
      [b.case.id]
    );
    // Reminders for this department start again from scratch.
    await client.query('DELETE FROM offboarding_reminder_log WHERE case_id = $1 AND department_id = $2', [b.case.id, deptId]);
    await lifecycle.logEvent(client, b.case.id, req.admin, 'section_reopened', {
      department_id: deptId, department: section.department_name, reason: clean(req.body && req.body.reason),
      previous_status: b.case.status, previous_signer: section.signed_by_name,
    });
    followUp = { previousStatus: b.case.status, department: section.department_name, reason: clean(req.body && req.body.reason) };
  });
  // Tell the department it has the checklist again, and — if Payroll had
  // already been asked to pay — tell Payroll to hold off.
  await afterCommitEmail(req.params.id, req.admin, 'clearance_task', { departmentIds: [deptId] });
  if (followUp.previousStatus === 'pending_payroll') {
    await afterCommitEmail(req.params.id, req.admin, 'payroll_hold', { department: followUp.department, reason: followUp.reason });
  }
  res.json(present(req, await visibleBundle(req)));
}));

// ---------------------------------------------------------------------------
// HR Section D, payroll
// ---------------------------------------------------------------------------
router.post('/cases/:id/hr-signoff', handle(async (req, res) => {
  const name = clean(req.body && req.body.name);
  const position = clean(req.body && req.body.position);
  if (!name || !position) fail(400, 'Name and position are required');
  await db.withTransaction(async (client) => {
    const b = await lockedBundle(client, req);
    if (!access.isHrFor(req.admin, b.case.business_unit)) fail(403, 'Only HR can sign Section D');
    requireNotOwnCase(req, b.case);
    if (!b.exitInterview || !b.exitInterview.employee_signed_at) fail(409, 'The employee has not submitted the Exit Interview yet');
    if (b.case.status === 'cancelled') fail(409, 'This case was cancelled');
    if (b.case.status === 'completed') fail(409, 'This case is closed — Section D can no longer be changed');
    await client.query(
      `UPDATE offboarding_exit_interviews SET hr_signed_name = $2, hr_signed_position = $3, hr_comments = $4, hr_signed_at = now()
        WHERE case_id = $1`,
      [b.case.id, name, position, clean(req.body.comments)]
    );
    await lifecycle.logEvent(client, b.case.id, req.admin, 'hr_signed', { name, position });
  });
  res.json(present(req, await visibleBundle(req)));
}));

router.post('/cases/:id/payroll-done', handle(async (req, res) => {
  await db.withTransaction(async (client) => {
    const b = await lockedBundle(client, req);
    if (!access.isPayrollFor(req.admin, b.case.business_unit)) fail(403, 'Only the Payroll PIC can mark payroll done');
    requireNotOwnCase(req, b.case);
    if (b.case.status !== 'pending_payroll') fail(409, 'Payroll can be marked done only after the employee has acknowledged');
    await client.query(
      `UPDATE offboarding_cases SET status = 'completed', payroll_completed_at = now(), payroll_completed_by_email = $2, payroll_remarks = $3
        WHERE id = $1`,
      [b.case.id, lc(req.admin.email) || 'admin', clean(req.body && req.body.remarks)]
    );
    await lifecycle.logEvent(client, b.case.id, req.admin, 'payroll_done', { remarks: clean(req.body && req.body.remarks) });
  });
  await afterCommitEmail(req.params.id, req.admin, 'completed');
  res.json(present(req, await visibleBundle(req)));
}));

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------
async function sendPdf(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
}

router.get('/cases/:id/pdf/exit-interview', handle(async (req, res) => {
  const b = await visibleBundle(req);
  if (!access.isHrFor(req.admin, b.case.business_unit) && !access.isPayrollFor(req.admin, b.case.business_unit)) {
    fail(403, 'The Exit Interview is confidential to HR');
  }
  if (!b.exitInterview || !b.exitInterview.employee_signed_at) fail(409, 'The Exit Interview has not been submitted yet');
  await sendPdf(res, await pdf.exitInterviewPdf(b), `Exit-Interview-${b.case.ref_no}.pdf`);
}));

router.get('/cases/:id/pdf/clearance', handle(async (req, res) => {
  const b = await visibleBundle(req);
  if (!['pending_payroll', 'completed'].includes(b.case.status)) fail(409, 'The Clearance Form is available once the employee has acknowledged');
  await sendPdf(res, await pdf.clearancePdf(b), `Exit-Clearance-${b.case.ref_no}.pdf`);
}));

// ---------------------------------------------------------------------------
// My tasks (sidebar badge + PIC home)
// ---------------------------------------------------------------------------
router.get('/my-tasks', handle(async (req, res) => {
  const a = req.admin;
  const email = lc(a.email);
  const today = dates.todayMYT();
  const values = [email];
  const ownParts = ['lower(s.assignee_email) = $1'];
  const depts = a.roles.clearance_department_ids || [];
  if (a.unitScope !== 'SUPERIOR' && !access.isSuper(a) && depts.length) {
    values.push(depts, a.unitScope);
    ownParts.push('(s.assignee_email IS NULL AND s.department_id = ANY($2::int[]) AND c.business_unit = $3)');
  }
  const sections = await db.query(
    `SELECT DISTINCT ON (s.id) s.id AS section_id, s.case_id, s.department_id, d.name AS department_name,
            c.ref_no, c.employee_name, c.business_unit, c.position,
            COALESCE(c.actual_last_day, c.official_last_day) AS last_day
       FROM offboarding_clearance_sections s
       JOIN offboarding_cases c ON c.id = s.case_id
       JOIN clearance_departments d ON d.id = s.department_id
      WHERE s.status = 'pending' AND c.status = 'clearance_in_progress'
        AND lower(c.employee_email) <> $1
        AND (${ownParts.join(' OR ')})
      ORDER BY s.id`,
    values
  );
  let payroll = { rows: [] };
  if (a.unitScope !== 'SUPERIOR' && a.roles.payroll_pic) {
    payroll = await db.query(
      `SELECT id, ref_no, employee_name, business_unit, position, acknowledged_at,
              COALESCE(actual_last_day, official_last_day) AS last_day
         FROM offboarding_cases
        WHERE status = 'pending_payroll' ${access.isSuper(a) ? '' : 'AND business_unit = $1'}
        ORDER BY acknowledged_at NULLS LAST`,
      access.isSuper(a) ? [] : [a.unitScope]
    );
  }
  const withDays = (r) => ({ ...r, days_left: r.last_day ? dates.daysBetween(today, r.last_day) : null });
  const secRows = sections.rows.map(withDays).sort((x, y) => (x.days_left ?? 9999) - (y.days_left ?? 9999));
  res.json({ sections: secRows, payroll: payroll.rows.map(withDays), count: secRows.length + payroll.rows.length });
}));

module.exports = router;
