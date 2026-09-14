'use strict';

// ============================================================================
// Exit interview / offboarding endpoints (spec §1.4, §2.4, §6.9).
//
// Reachable once the parent application's status = 'offboarding'
// (`exit_interviews` row is actually created as a side effect of the admin's
// `rpc_admin_set_offboarding`-equivalent — see routes/admin.js — but this
// module lazily creates it too, matching the reference RPC's own
// "fetch or lazily create" behavior, in case a candidate reaches the deep
// link before/without that side effect having run for any reason).
//
// Locked after signing: once `employee_signed = true`, PATCH is rejected —
// Sections A-C become immutable exactly like the reference app's disabled
// form inputs post-signature.
// ============================================================================

const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireCandidateAuth } = require('../middleware/auth');
const { buildPatchUpdate, stripEmptyStrings } = require('../lib/patchMerge');
const { notify } = require('../lib/powerAutomate');
const { getBuAdminEmails } = require('../lib/notificationHelpers');

const router = express.Router();
router.use(requireCandidateAuth);

// Excludes id, application_id, employee_signed*, hr_signed* (signature
// columns are written only by their dedicated endpoints), created_at,
// updated_at.
const EXIT_INTERVIEW_PATCH_COLUMNS = [
  'position', 'immediate_superior', 'dept_site', 'date_joined',
  'notice_period', 'official_last_day', 'actual_last_day',
  'reasons', // jsonb array — always sent in full (spec §1.4)
  'reasons_other_specify', 'comments',
];

async function getOwnedExitInterview(req, res) {
  const { application_id: applicationId } = req.params;

  const appRows = await db.query(
    'SELECT id, name_nric, email, business_unit, reference_no FROM applications WHERE id = $1 AND user_id = $2',
    [applicationId, req.user.id]
  );
  if (appRows.rows.length === 0) {
    res.status(404).json({ error: 'Application not found or not owned by you' });
    return null;
  }
  const app = appRows.rows[0];

  let eiRows = await db.query('SELECT * FROM exit_interviews WHERE application_id = $1', [applicationId]);
  if (eiRows.rows.length === 0) {
    eiRows = await db.query(
      'INSERT INTO exit_interviews (application_id) VALUES ($1) RETURNING *',
      [applicationId]
    );
  }
  return { record: eiRows.rows[0], app };
}

// GET /api/exit-interviews/:application_id  (rpc_get_my_exit_interview)
router.get('/:application_id', asyncHandler(async (req, res) => {
  const ctx = await getOwnedExitInterview(req, res);
  if (!ctx) return;
  return res.json(ctx.record);
}));

// PATCH /api/exit-interviews/:application_id  (rpc_save_my_exit_interview)
router.patch('/:application_id', asyncHandler(async (req, res) => {
  const ctx = await getOwnedExitInterview(req, res);
  if (!ctx) return;

  if (ctx.record.employee_signed) {
    return res.status(409).json({ error: 'Exit interview is locked after signing and can no longer be edited' });
  }

  const patch = req.body && req.body.patch;
  if (typeof patch !== 'object' || patch === null) {
    return res.status(400).json({ error: 'patch is required' });
  }

  const cleanPatch = stripEmptyStrings(patch);
  const update = buildPatchUpdate('exit_interviews', 'application_id', req.params.application_id, cleanPatch, EXIT_INTERVIEW_PATCH_COLUMNS);

  if (!update) {
    return res.json(ctx.record);
  }

  const { rows } = await db.query(update.text, update.values);
  return res.json(rows[0]);
}));

// POST /api/exit-interviews/:application_id/submit  (rpc_submit_my_exit_interview)
router.post('/:application_id/submit', asyncHandler(async (req, res) => {
  const ctx = await getOwnedExitInterview(req, res);
  if (!ctx) return;

  if (ctx.record.employee_signed) {
    return res.status(409).json({ error: 'Exit interview has already been signed' });
  }

  const { rows } = await db.query(
    `UPDATE exit_interviews
       SET employee_signed = true, employee_signed_name = $1, employee_signed_at = now()
     WHERE application_id = $2
     RETURNING *`,
    [ctx.app.name_nric, req.params.application_id]
  );
  const ei = rows[0];

  // Power Automate notification (mirrors the original
  // `notify_power_automate_on_exit_interview_signed` trigger's 'employee_signed'
  // branch, formerly fired from `rpc_submit_my_exit_interview`).
  const notifyEmails = await getBuAdminEmails(ctx.app.business_unit);
  notify('exit_interview', {
    event_type: 'employee_signed',
    application_id: req.params.application_id,
    reference_no: ctx.app.reference_no || '',
    candidate_name: ctx.app.name_nric || '',
    position: ei.position || '',
    business_unit: ctx.app.business_unit || '',
    notify_email: notifyEmails.join(';'),
    admin_link: `${process.env.FRONTEND_BASE_URL || 'https://bqphua.github.io/job-app'}/admin.html?app=${req.params.application_id}`,
  });

  return res.json(ei);
}));

module.exports = router;
