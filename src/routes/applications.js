'use strict';

// ============================================================================
// Candidate application lifecycle + consent endpoints (spec §1.1, §1.2).
//
// Every endpoint enforces ownership via `req.user.id` (populated by
// `requireCandidateAuth`), mirroring the original RPCs' implicit
// `auth.uid()` filtering — there is no `p_user_id` param anywhere in the
// spec because Supabase RPCs ran under the caller's session; here we get
// the same effect by always including `user_id = req.user.id` in the
// WHERE clause of every query that touches an application row.
// ============================================================================

const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireCandidateAuth } = require('../middleware/auth');
const { buildPatchUpdate, stripEmptyStrings } = require('../lib/patchMerge');
const { generateReferenceNo } = require('../lib/referenceNo');
const { notify, sanitizeNotificationPayload } = require('../lib/powerAutomate');
const { getBuAdminEmails } = require('../lib/notificationHelpers');

const router = express.Router();
router.use(requireCandidateAuth);

const VALID_BUSINESS_UNITS = ['E&C', 'Land', 'Mall'];

// Columns a candidate's own PATCH /api/applications/:id may touch (spec
// §6.2). Deliberately excludes: id, user_id, reference_no, status,
// business_unit, company_id, submitted_at, created_at, updated_at (all
// system/admin-managed), and the jts_/pdpa_ consent columns (written only by
// the dedicated /consent/jts and /consent/pdpa endpoints below, never via
// the generic patch, so consent timestamps can't be spoofed via a stray
// patch key). `position_applying` does not appear here — the product
// owner confirmed (2026-09-11) that field was removed from the
// application long ago; it no longer exists in the schema (see
// db/migrations/002_position_applying_and_refno.sql).
const APPLICATION_PATCH_COLUMNS = [
  'name_nric', 'alias', 'permanent_address', 'permanent_postcode',
  'correspondence_address', 'correspondence_postcode', 'tel_residence',
  'tel_office', 'mobile_phone', 'email', 'place_of_birth', 'nric_new',
  'passport_number', 'citizen', 'marital_status', 'date_of_birth', 'age',
  'bumiputra', 'race',
  'epf_no', 'income_tax_no', 'tax_branch', 'socso_no', 'bank_account_no',
  'cidb_green_card_no', 'cidb_branch',
  'language_ability', 'education', 'working_experience', // jsonb — always sent in full (spec §6.2 note 5)
  'resignation_notice_required', 'notice_period', 'date_available_to_start',
  'expected_basic_salary', 'relatives_in_company', 'relatives_name',
  'relatives_relationship', 'referral_person', 'referral_name',
  'referral_department', 'own_transport_motorcar', 'own_transport_motorcycle',
  'willing_based_outside_klang_valley', 'physical_defects',
  'physical_defects_specify', 'arrested_convicted', 'arrested_convicted_specify',
  'referee1', 'referee2', // jsonb
  'declaration_lawsuit', 'declaration_lawsuit_specify',
  'declaration_other_matters', 'declaration_other_matters_specify',
  'profile_picture_url', 'attachments', // jsonb array; see task brief re: pre-uploaded file metadata/URL patch pattern
  'language_choice',
];

// POST /api/applications  (rpc_create_draft)
router.post('/', asyncHandler(async (req, res) => {
  const { business_unit: businessUnit } = req.body || {};
  if (!VALID_BUSINESS_UNITS.includes(businessUnit)) {
    return res.status(400).json({ error: `business_unit must be one of ${VALID_BUSINESS_UNITS.join(', ')}` });
  }

  const result = await db.withTransaction(async (client) => {
    const referenceNo = await generateReferenceNo(client, businessUnit);
    const { rows } = await client.query(
      `INSERT INTO applications (user_id, business_unit, reference_no, status)
       VALUES ($1, $2, $3, 'draft')
       RETURNING id, reference_no`,
      [req.user.id, businessUnit, referenceNo]
    );
    return rows[0];
  });

  return res.status(201).json(result);
}));

// GET /api/applications/mine  (rpc_get_my_applications)
router.get('/mine', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM applications WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  return res.json(rows);
}));

// GET /api/applications/:id  (single row, used by continue-draft / review / PDF)
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM applications WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  return res.json(rows[0]);
}));

// PATCH /api/applications/:id  (rpc_save_application)
router.patch('/:id', asyncHandler(async (req, res) => {
  const { reference_no: referenceNo, patch } = req.body || {};
  if (!referenceNo || typeof patch !== 'object' || patch === null) {
    return res.status(400).json({ error: 'reference_no and patch are required' });
  }

  // Verify ownership + defensive reference_no match + draft-only, before
  // attempting the patch (spec §1.1: "verify p_reference_no matches ... and
  // probably that status='draft'").
  const existing = await db.query(
    'SELECT id, status FROM applications WHERE id = $1 AND user_id = $2 AND reference_no = $3',
    [req.params.id, req.user.id, referenceNo]
  );
  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'Application not found, not owned by you, or reference_no mismatch' });
  }
  if (existing.rows[0].status !== 'draft') {
    return res.status(409).json({ error: 'Only draft applications can be saved' });
  }

  const cleanPatch = stripEmptyStrings(patch);
  const update = buildPatchUpdate('applications', 'id', req.params.id, cleanPatch, APPLICATION_PATCH_COLUMNS, {
    extraWhere: { user_id: req.user.id },
  });

  if (!update) {
    // Nothing to update — return the current row, matching the RPC's
    // "no-op is not an error" behavior.
    const { rows } = await db.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    return res.json(rows[0]);
  }

  const { rows } = await db.query(update.text, update.values);
  return res.json(rows[0]);
}));

// DELETE /api/applications/:id  (rpc_delete_my_draft_application)
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await db.query(
    `DELETE FROM applications WHERE id = $1 AND user_id = $2 AND status = 'draft'`,
    [req.params.id, req.user.id]
  );
  if (rowCount === 0) {
    return res.status(404).json({ error: 'Draft application not found, not owned by you, or already submitted' });
  }
  return res.status(204).send();
}));

// POST /api/applications/:id/submit  (rpc_submit_application)
router.post('/:id/submit', asyncHandler(async (req, res) => {
  const { reference_no: referenceNo } = req.body || {};
  if (!referenceNo) return res.status(400).json({ error: 'reference_no is required' });

  const { rows } = await db.query(
    'SELECT id, status, pdpa_agreed FROM applications WHERE id = $1 AND user_id = $2 AND reference_no = $3',
    [req.params.id, req.user.id, referenceNo]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Application not found, not owned by you, or reference_no mismatch' });
  }
  const app = rows[0];
  if (app.status !== 'draft') {
    return res.status(409).json({ error: 'Only draft applications can be submitted' });
  }
  if (!app.pdpa_agreed) {
    return res.status(422).json({ error: 'PDPA consent must be recorded before submission' });
  }

  const updated = await db.query(
    `UPDATE applications SET status = 'submitted', submitted_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  const submittedApp = updated.rows[0];

  // Power Automate notification (mirrors the original
  // `notify_power_automate_on_submit` trigger) — fire-and-forget, must never
  // fail the candidate's submit request.
  const notifyEmails = await getBuAdminEmails(submittedApp.business_unit);
  notify('submit', sanitizeNotificationPayload({
    ...submittedApp,
    notify_email: notifyEmails.join(';'),
  }));

  return res.json(submittedApp);
}));

// POST /api/applications/:id/consent/jts  (rpc_agree_jts)
router.post('/:id/consent/jts', asyncHandler(async (req, res) => {
  const { reference_no: referenceNo, name, nric, mobile } = req.body || {};
  if (!referenceNo || !name || !nric || !mobile) {
    return res.status(400).json({ error: 'reference_no, name, nric, and mobile are required' });
  }

  const { rowCount, rows } = await db.query(
    `UPDATE applications
       SET jts_agreed = true, jts_agreed_name = $1, jts_agreed_nric = $2,
           jts_agreed_mobile = $3, jts_agreed_at = now()
     WHERE id = $4 AND user_id = $5 AND reference_no = $6
     RETURNING *`,
    [name, nric, mobile, req.params.id, req.user.id, referenceNo]
  );
  if (rowCount === 0) {
    return res.status(404).json({ error: 'Application not found, not owned by you, or reference_no mismatch' });
  }
  return res.json(rows[0]);
}));

// POST /api/applications/:id/consent/pdpa  (rpc_agree_pdpa)
router.post('/:id/consent/pdpa', asyncHandler(async (req, res) => {
  const { reference_no: referenceNo, name, nric } = req.body || {};
  if (!referenceNo || !name || !nric) {
    return res.status(400).json({ error: 'reference_no, name, and nric are required' });
  }

  const { rowCount, rows } = await db.query(
    `UPDATE applications
       SET pdpa_agreed = true, pdpa_agreed_name = $1, pdpa_agreed_nric = $2,
           pdpa_agreed_at = now()
     WHERE id = $3 AND user_id = $4 AND reference_no = $5
     RETURNING *`,
    [name, nric, req.params.id, req.user.id, referenceNo]
  );
  if (rowCount === 0) {
    return res.status(404).json({ error: 'Application not found, not owned by you, or reference_no mismatch' });
  }
  return res.json(rows[0]);
}));

// GET /api/blacklist-check  (rpc_check_blacklist)
// Mounted directly (not nested under this router) since it isn't scoped to
// a specific application id — exported here for app.js to wire up alongside
// the rest of the candidate-auth-protected surface. Called once at boot,
// before rendering anything else (spec §1.1, §3.1) — kept a fast, indexed
// lookup on `candidate_blacklist(email)`.
async function blacklistCheck(req, res) {
  const { rows } = await db.query(
    'SELECT 1 FROM candidate_blacklist WHERE email = $1 AND is_blacklisted = true',
    [req.user.email]
  );
  return res.json({ blacklisted: rows.length > 0 });
}

module.exports = router;
module.exports.blacklistCheck = asyncHandler(blacklistCheck);
module.exports.APPLICATION_PATCH_COLUMNS = APPLICATION_PATCH_COLUMNS;
