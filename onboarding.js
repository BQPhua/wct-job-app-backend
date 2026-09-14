'use strict';

// ============================================================================
// Onboarding (post-hire) endpoints (spec §1.3, §2.3, §6.8).
//
// Reachable only once the parent application's status = 'hired'. Ownership
// is always verified via a join back to `applications.user_id = req.user.id`
// since `onboarding_records` itself has no user_id column (1:1 with
// applications, not directly with users).
// ============================================================================

const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireCandidateAuth } = require('../middleware/auth');
const { buildPatchUpdate, stripEmptyStrings } = require('../lib/patchMerge');
const { notify, sanitizeNotificationPayload } = require('../lib/powerAutomate');
const { getManagerEmail } = require('../lib/notificationHelpers');

const router = express.Router();
router.use(requireCandidateAuth);

// Sections required for onboarding completion (spec §1.3): the reference
// implementation's server-side check still requires 'tp3' alongside the two
// sections actually exposed in the candidate UI, purely because the client
// silently double-calls confirm with p_section='tp3' right after
// 'personal_details' to keep that legacy gate satisfied. We preserve the
// exact same three-section completion rule here (rather than simplifying to
// two) so a client that DOESN'T send the redundant tp3 confirm call would
// leave onboarding stuck at 'in_progress' forever — matching current
// behavior exactly is safer than guessing this is safe to drop.
const REQUIRED_SECTIONS = ['personal_details', 'tp3', 'salary_crediting'];
const SECTION_COLUMN = {
  personal_details: 'personal_details_confirmed',
  tp3: 'tp3_confirmed',
  salary_crediting: 'salary_crediting_confirmed',
};

// Columns a candidate's PATCH may touch. Excludes id, application_id,
// status, the *_confirmed/*_confirmed_at columns (written only via the
// confirm-section endpoint, never the generic patch — same rationale as
// consent columns on applications), created_at, updated_at.
const ONBOARDING_PATCH_COLUMNS = [
  'epf_no', 'income_tax_no', 'tax_branch', 'socso_no', 'bank_account_no',
  'cidb_green_card_no', 'cidb_branch',
  'spouse_name', 'spouse_nric', 'spouse_date_of_birth', 'spouse_working',
  'children_below_18', 'children_18_to_23', // jsonb — always sent in full (spec §1.3)
  'emergency_contacts', // jsonb — always sent in full
  'beneficiary_name', 'beneficiary_relationship', 'beneficiary_contact',
  'tp3_data', // jsonb
  'salary_company', 'salary_bank', 'salary_branch', 'salary_account_no',
  'salary_ic_submitted',
];

/**
 * Verify the application belongs to req.user and is status='hired', then
 * fetch (or lazily create) its onboarding_records row. Returns the row, or
 * null with the response already sent on failure.
 */
async function getOwnedHiredOnboarding(req, res) {
  const { application_id: applicationId } = req.params;

  const appRows = await db.query(
    `SELECT id, status, name_nric, nric_new, passport_number, business_unit, reference_no FROM applications
     WHERE id = $1 AND user_id = $2`,
    [applicationId, req.user.id]
  );
  if (appRows.rows.length === 0) {
    res.status(404).json({ error: 'Application not found or not owned by you' });
    return null;
  }
  const app = appRows.rows[0];
  if (app.status !== 'hired') {
    res.status(403).json({ error: "Onboarding is only available once status='hired'" });
    return null;
  }

  let obRows = await db.query('SELECT * FROM onboarding_records WHERE application_id = $1', [applicationId]);
  if (obRows.rows.length === 0) {
    // Lazily create, per spec §1.3 ("candidates reach this without an
    // explicit 'create' call"). Seed salary_ic_submitted from the parent
    // application's NRIC/passport, matching the reference app's default.
    const icSubmitted = app.nric_new || app.passport_number || null;
    obRows = await db.query(
      `INSERT INTO onboarding_records (application_id, salary_ic_submitted)
       VALUES ($1, $2)
       RETURNING *`,
      [applicationId, icSubmitted]
    );
  }

  return { record: obRows.rows[0], app };
}

// GET /api/onboarding/:application_id  (rpc_get_my_onboarding)
router.get('/:application_id', asyncHandler(async (req, res) => {
  const ctx = await getOwnedHiredOnboarding(req, res);
  if (!ctx) return; // response already sent
  return res.json(ctx.record);
}));

// PATCH /api/onboarding/:application_id  (rpc_save_my_onboarding)
router.patch('/:application_id', asyncHandler(async (req, res) => {
  const ctx = await getOwnedHiredOnboarding(req, res);
  if (!ctx) return;

  const patch = req.body && req.body.patch;
  if (typeof patch !== 'object' || patch === null) {
    return res.status(400).json({ error: 'patch is required' });
  }

  const cleanPatch = stripEmptyStrings(patch);
  const update = buildPatchUpdate('onboarding_records', 'application_id', req.params.application_id, cleanPatch, ONBOARDING_PATCH_COLUMNS);

  if (!update) {
    return res.json(ctx.record);
  }

  const { rows } = await db.query(update.text, update.values);
  return res.json(rows[0]);
}));

// POST /api/onboarding/:application_id/confirm-section  (rpc_confirm_onboarding_section)
router.post('/:application_id/confirm-section', asyncHandler(async (req, res) => {
  const ctx = await getOwnedHiredOnboarding(req, res);
  if (!ctx) return;

  const { section } = req.body || {};
  const column = SECTION_COLUMN[section];
  if (!column) {
    return res.status(400).json({ error: `section must be one of ${REQUIRED_SECTIONS.join(', ')}` });
  }

  let justCompleted = false;
  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE onboarding_records
         SET ${column} = true, ${column}_at = now()
       WHERE application_id = $1
       RETURNING *`,
      [req.params.application_id]
    );
    let updated = rows[0];

    const allConfirmed = REQUIRED_SECTIONS.every((s) => updated[SECTION_COLUMN[s]] === true);
    if (allConfirmed && updated.status !== 'completed') {
      const completedRows = await client.query(
        `UPDATE onboarding_records SET status = 'completed' WHERE application_id = $1 RETURNING *`,
        [req.params.application_id]
      );
      updated = completedRows.rows[0];
      justCompleted = true;
    }
    return updated;
  });

  if (justCompleted) {
    // Power Automate notification (mirrors the original
    // `notify_power_automate_on_onboarding_complete` trigger).
    const notifyEmail = await getManagerEmail(ctx.app.business_unit);
    notify('onboarding_complete', sanitizeNotificationPayload({
      ...result,
      notify_email: notifyEmail,
      reference_no: ctx.app.reference_no || '',
      name_nric: ctx.app.name_nric || '',
      business_unit: ctx.app.business_unit || '',
    }));
  }

  return res.json(result);
}));

module.exports = router;
