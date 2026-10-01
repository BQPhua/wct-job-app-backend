'use strict';

// ============================================================================
// Employee-side offboarding API — /api/offboarding
// (spec: docs/superpowers/specs/2026-09-30-offboarding-merge-design.md §5)
//
// The leaver uses the normal candidate site and candidate sign-in. Access is
// proven twice over:
//   1. the invite link carries a one-time token that only the invite email
//      contained (password accounts never verify their email address), and
//   2. the signed-in account's email must equal the invited email.
// POST /claim checks both once and binds the case to that user id; every
// other route then only serves cases bound to req.user.id.
// ============================================================================

const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireCandidateAuth } = require('../middleware/auth');
const lifecycle = require('../lib/offboarding/lifecycle');
const mailer = require('../lib/offboarding/mailer');
const pdf = require('../lib/offboarding/pdf');
const dates = require('../lib/offboarding/dates');
const { EXIT_REASONS, STATUS_LABELS, TOTAL_SECTIONS } = require('../lib/offboarding/constants');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => (UUID_RE.test(id) ? next() : res.status(404).json({ error: 'Offboarding case not found' })));

const lc = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const clean = (v) => { if (v == null) return null; const s = String(v).trim(); return s === '' ? null : s; };

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
const handle = (fn) => asyncHandler(async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    throw err;
  }
});

function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

const employeeActor = (req) => ({ kind: 'employee', email: lc(req.user.email) });

/** Employee's view of a case: no token, no internal ids of other staff. */
function present(bundle) {
  const { invite_token: _t, invited_by_email: _i, cancelled_by_email: _c, payroll_completed_by_email: _p, ...c } = bundle.case;
  return {
    case: {
      ...c,
      status_label: STATUS_LABELS[c.status],
      effective_last_day: c.actual_last_day || c.official_last_day || null,
      sections_signed: bundle.sections.filter((s) => s.status === 'complete').length,
      sections_total: TOTAL_SECTIONS,
    },
    exitInterview: bundle.exitInterview && {
      reasons: bundle.exitInterview.reasons,
      reasons_other: bundle.exitInterview.reasons_other,
      comments: bundle.exitInterview.comments,
      employee_signature_name: bundle.exitInterview.employee_signature_name,
      employee_signed_at: bundle.exitInterview.employee_signed_at,
    },
    // Read-only clearance summary (names of signers + remarks, no emails).
    sections: bundle.sections.map((s) => ({
      department_id: s.department_id,
      department_name: s.department_name,
      status: s.status,
      signed_by_name: s.signed_by_name,
      signed_at: s.signed_at,
      items: s.items
        .filter((i) => !i.is_other || i.custom_text || i.is_checked || i.remarks)
        .map((i) => ({ item_text: i.is_other ? `Others${i.custom_text ? `: ${i.custom_text}` : ''}` : i.item_text, is_checked: i.is_checked, remarks: i.remarks })),
    })),
    reasons: EXIT_REASONS,
    today: dates.todayMYT(),
  };
}

async function ownBundle(req, q = db, { lock = false } = {}) {
  if (lock) await lifecycle.lockCase(q, req.params.id);
  const { rows } = await q.query('SELECT id FROM offboarding_cases WHERE id = $1 AND employee_user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) fail(404, 'Offboarding case not found');
  return lifecycle.loadBundle(q, req.params.id);
}

async function emailAfterCommit(caseId, req, eventType) {
  const bundle = await lifecycle.loadBundle(db, caseId);
  const r = await mailer.send(eventType, bundle);
  if (!r.ok) await lifecycle.logEvent(db, caseId, employeeActor(req), 'email_failed', { email: eventType });
}

// Reusable field clean-up for draft saves and submit.
function interviewPatch(body) {
  const casePatch = {};
  const eiPatch = {};
  if ('immediate_superior_name' in body) casePatch.immediate_superior_name = clean(body.immediate_superior_name);
  if ('notice_period_days' in body) {
    const n = body.notice_period_days === '' || body.notice_period_days == null ? null : Number(body.notice_period_days);
    casePatch.notice_period_days = n;
  }
  for (const k of ['official_last_day', 'actual_last_day']) {
    if (k in body) casePatch[k] = dates.isIsoDate(body[k]) ? body[k] : null;
  }
  if ('reasons' in body) {
    eiPatch.reasons = JSON.stringify((Array.isArray(body.reasons) ? body.reasons : []).filter((r) => EXIT_REASONS.includes(r)));
  }
  if ('reasons_other' in body) {
    eiPatch.reasons_other = (Array.isArray(body.reasons_other) ? body.reasons_other : [])
      .map((r) => clean(r)).filter(Boolean).map((r) => r.slice(0, 200)).slice(0, 10);
  }
  if ('comments' in body) eiPatch.comments = clean(body.comments) && clean(body.comments).slice(0, 5000);
  return { casePatch, eiPatch };
}

async function applyPatch(client, caseId, { casePatch, eiPatch }) {
  const ck = Object.keys(casePatch);
  if (ck.length) {
    if ('notice_period_days' in casePatch && casePatch.notice_period_days != null
      && (!Number.isInteger(casePatch.notice_period_days) || casePatch.notice_period_days < 0)) {
      fail(422, 'Notice period must be a whole number of days (0 or more)', { field: 'notice_period_days' });
    }
    await client.query(`UPDATE offboarding_cases SET ${ck.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [caseId, ...ck.map((k) => casePatch[k])]);
  }
  const ek = Object.keys(eiPatch);
  if (ek.length) {
    await client.query(`UPDATE offboarding_exit_interviews SET ${ek.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE case_id = $1`,
      [caseId, ...ek.map((k) => eiPatch[k])]);
  }
}

// ---------------------------------------------------------------------------
// Protected routes
// ---------------------------------------------------------------------------
router.post('/claim', requireCandidateAuth, handle(async (req, res) => {
  const token = clean(req.body && req.body.token);
  if (!token) fail(400, 'Invitation token is missing');
  const out = await db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM offboarding_cases WHERE invite_token = $1 FOR UPDATE', [token]);
    const c = rows[0];
    if (!c) fail(404, 'This offboarding invitation link is not valid. Please use the latest email from HR.');
    if (lc(req.user.email) !== c.employee_email) {
      fail(403, `This invitation was sent to ${maskEmail(c.employee_email)}. Please sign out and sign in with that email address.`,
        { invited_email_masked: maskEmail(c.employee_email) });
    }
    if (c.employee_user_id && c.employee_user_id !== req.user.id) {
      fail(403, 'This invitation is already linked to another account. Please contact HR.');
    }
    if (!c.employee_user_id) {
      await client.query('UPDATE offboarding_cases SET employee_user_id = $2 WHERE id = $1', [c.id, req.user.id]);
      await lifecycle.logEvent(client, c.id, employeeActor(req), 'invite_opened', {});
    }
    return { case_id: c.id, status: c.status };
  });
  res.json(out);
}));

router.get('/mine', requireCandidateAuth, handle(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, ref_no, status, business_unit, position, official_last_day, actual_last_day, invited_at, updated_at
       FROM offboarding_cases WHERE employee_user_id = $1 ORDER BY invited_at DESC`,
    [req.user.id]
  );
  res.json(rows.map((r) => ({ ...r, status_label: STATUS_LABELS[r.status] })));
}));

router.get('/mine/:id', requireCandidateAuth, handle(async (req, res) => {
  res.json(present(await ownBundle(req)));
}));

router.patch('/mine/:id/exit-interview', requireCandidateAuth, handle(async (req, res) => {
  await db.withTransaction(async (client) => {
    const b = await ownBundle(req, client, { lock: true });
    if (b.case.status !== 'invited') fail(409, 'Your Exit Interview has already been submitted and can no longer be changed');
    await applyPatch(client, b.case.id, interviewPatch(req.body || {}));
    await lifecycle.logEvent(client, b.case.id, employeeActor(req), 'interview_saved', {});
  });
  res.json(present(await ownBundle(req)));
}));

router.post('/mine/:id/exit-interview/submit', requireCandidateAuth, handle(async (req, res) => {
  const body = req.body || {};
  await db.withTransaction(async (client) => {
    const b = await ownBundle(req, client, { lock: true });
    if (b.case.status !== 'invited') fail(409, 'Your Exit Interview has already been submitted');
    await applyPatch(client, b.case.id, interviewPatch(body));
    const fresh = await lifecycle.loadBundle(client, b.case.id);
    const c = fresh.case;
    const ei = fresh.exitInterview;
    const today = dates.todayMYT();

    if (c.notice_period_days == null) fail(422, 'Please enter your notice period in days', { field: 'notice_period_days' });
    if (!c.official_last_day) fail(422, 'Please enter your official last day', { field: 'official_last_day' });
    const minOfficial = dates.addDays(today, c.notice_period_days);
    if (c.official_last_day < minOfficial) {
      fail(422, `With a ${c.notice_period_days}-day notice period, your official last day must be on or after ${minOfficial}`, { field: 'official_last_day' });
    }
    if (!c.actual_last_day) fail(422, 'Please enter your actual last day', { field: 'actual_last_day' });
    if (c.actual_last_day < today) fail(422, 'Your actual last day cannot be in the past', { field: 'actual_last_day' });
    if (c.actual_last_day < c.official_last_day) {
      fail(422, 'Your actual last day cannot be before your official last day', { field: 'actual_last_day' });
    }
    if ((ei.reasons || []).length === 0 && (ei.reasons_other || []).length === 0) {
      fail(422, 'Please choose at least one reason for leaving, or add your own', { field: 'reasons' });
    }
    const signature = clean(body.signature_name);
    if (!signature) fail(422, 'Please type your full name to sign', { field: 'signature_name' });
    if (body.declaration !== true) fail(422, 'Please confirm the declaration', { field: 'declaration' });

    await client.query(
      'UPDATE offboarding_exit_interviews SET employee_signature_name = $2, employee_signed_at = now() WHERE case_id = $1',
      [c.id, signature.slice(0, 200)]
    );
    const { rows } = await client.query(
      "UPDATE offboarding_cases SET status = 'clearance_in_progress', submitted_at = now() WHERE id = $1 RETURNING *",
      [c.id]
    );
    await lifecycle.createSections(client, rows[0]);
    await lifecycle.logEvent(client, c.id, employeeActor(req), 'interview_submitted', {});
  });
  await emailAfterCommit(req.params.id, req, 'submitted_hr');
  await emailAfterCommit(req.params.id, req, 'clearance_task');
  res.json(present(await ownBundle(req)));
}));

router.post('/mine/:id/acknowledge', requireCandidateAuth, handle(async (req, res) => {
  const body = req.body || {};
  await db.withTransaction(async (client) => {
    const b = await ownBundle(req, client, { lock: true });
    if (b.case.status !== 'pending_acknowledgement') fail(409, 'Your clearance is not ready to acknowledge yet');
    const signature = clean(body.signature_name);
    if (!signature) fail(422, 'Please type your full name to sign', { field: 'signature_name' });
    if (body.declaration !== true) fail(422, 'Please confirm the declaration', { field: 'declaration' });
    await client.query(
      `UPDATE offboarding_cases SET status = 'pending_payroll', acknowledged_at = now(), acknowledged_signature_name = $2
        WHERE id = $1`,
      [b.case.id, signature.slice(0, 200)]
    );
    await lifecycle.logEvent(client, b.case.id, employeeActor(req), 'acknowledged', {});
  });
  await emailAfterCommit(req.params.id, req, 'payroll_action');
  res.json(present(await ownBundle(req)));
}));

router.get('/mine/:id/pdf/exit-interview', requireCandidateAuth, handle(async (req, res) => {
  const b = await ownBundle(req);
  if (!b.exitInterview || !b.exitInterview.employee_signed_at) fail(409, 'Your Exit Interview has not been submitted yet');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Exit-Interview-${b.case.ref_no}.pdf"`);
  res.send(await pdf.exitInterviewPdf(b));
}));

router.get('/mine/:id/pdf/clearance', requireCandidateAuth, handle(async (req, res) => {
  const b = await ownBundle(req);
  if (!['pending_payroll', 'completed'].includes(b.case.status)) fail(409, 'The Clearance Form is available after you acknowledge it');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Exit-Clearance-${b.case.ref_no}.pdf"`);
  res.send(await pdf.clearancePdf(b));
}));

module.exports = router;
