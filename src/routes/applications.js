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
const businessUnits = require('../lib/businessUnits');
const { sendSubmissionEmails } = require('../lib/submissionEmails');

const router = express.Router();
router.use(requireCandidateAuth);

// Columns a candidate's own PATCH /api/applications/:id may touch (spec
// §6.2). Deliberately excludes: id, user_id, reference_no, status,
// business_unit, company_id, submitted_at, created_at, updated_at (all
// system/admin-managed), and the jts_/pdpa_ consent columns (written only by
// the dedicated /consent/jts and /consent/pdpa endpoints below, never via
// the generic patch, so consent timestamps can't be spoofed via a stray
// patch key). `position_applying` was removed 2026-09-11 and reinstated
// 2026-09-17 (db/migrations/004_re_add_position_applying.sql) — it's back
// in the list below since candidates now fill it in on the form's first page.
const APPLICATION_PATCH_COLUMNS = [
  'position_applying',
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
  'no_referees', // migration 009
  'declaration_lawsuit', 'declaration_lawsuit_specify',
  'declaration_other_matters', 'declaration_other_matters_specify',
  'profile_picture_url', 'attachments', // jsonb array; see task brief re: pre-uploaded file metadata/URL patch pattern
  'language_choice',
  // Form v2 (migration 008): two-line addresses, "no previous working
  // experience", and the optional family details moved here from onboarding.
  'permanent_address2', 'permanent_city', 'permanent_state',
  'correspondence_address2', 'correspondence_city', 'correspondence_state',
  'no_working_experience',
  'spouse_name', 'spouse_nric', 'spouse_date_of_birth', 'spouse_working',
  'children_below_18', 'children_18_to_23', // jsonb — always sent in full
  // Form v3 (migration 010): spouse's occupation and the number of children;
  // each child's details are collected at onboarding.
  'spouse_occupation', 'children_below_18_count', 'children_18_to_23_count',
];

// ---------------------------------------------------------------------------
// Shape checks for the fields admins later see as links, images and ratings.
// File links must be ones our own upload endpoint produced (/api/files/...,
// or an old Azure Blob link), so a crafted value can't become script in the
// admin dashboard.
// ---------------------------------------------------------------------------
const FILE_URL_RE = /^(\/api\/files\/[A-Za-z0-9._\/-]+\?exp=\d{1,12}&sig=[A-Za-z0-9_-]+|https:\/\/[a-z0-9-]+\.blob\.core\.windows\.net\/[A-Za-z0-9._~%\/?&=:+-]+)$/;
const DOC_CATEGORIES = ['ic_front', 'ic_back', 'resume', 'academic', 'payslip', 'declaration', 'other'];
const RATINGS = ['', 'Good', 'Fair', 'Slight', 'N/A'];
function invalidPatchReason(p) {
  if (p.profile_picture_url != null && !FILE_URL_RE.test(String(p.profile_picture_url))) return 'profile_picture_url must be an uploaded file link';
  if (p.attachments !== undefined) {
    if (!Array.isArray(p.attachments) || p.attachments.length > 60) return 'attachments must be a list (at most 60 files)';
    for (const f of p.attachments) {
      if (!f || typeof f !== 'object' || !FILE_URL_RE.test(String(f.url || ''))) return 'Each attachment must be an uploaded file link';
      if (typeof f.name !== 'string' || f.name.length > 255) return 'Each attachment needs a file name';
      if (f.category !== undefined && !DOC_CATEGORIES.includes(f.category)) return `attachment category must be one of ${DOC_CATEGORIES.join(', ')}`;
      if (f.type !== undefined && !/^[\w.+-]+\/[\w.+-]+$/.test(String(f.type))) return 'attachment type is not a valid file type';
    }
  }
  if (p.language_ability !== undefined) {
    if (!Array.isArray(p.language_ability) || p.language_ability.length > 30) return 'language_ability must be a list';
    if (p.language_ability.some((l) => !l || !RATINGS.includes(l.spoken || '') || !RATINGS.includes(l.written || ''))) return 'Language ratings must be Good, Fair, Slight or N/A';
  }
  for (const k of ['children_below_18_count', 'children_18_to_23_count']) {
    if (p[k] != null && !(Number.isInteger(p[k]) && p[k] >= 0 && p[k] <= 20)) return 'Number of children must be a whole number from 0 to 20';
  }
  if (p.spouse_occupation != null && String(p.spouse_occupation).length > 120) return 'Spouse occupation is too long';
  return null;
}

// POST /api/applications  (rpc_create_draft)
router.post('/', asyncHandler(async (req, res) => {
  // The candidate link's ?bu= may carry the code ("Land") or the display
  // name ("Property Development"); either way the code is what's stored.
  const bu = await businessUnits.resolve((req.body || {}).business_unit);
  if (!bu || !bu.is_active) {
    const active = await businessUnits.list({ activeOnly: true });
    return res.status(400).json({ error: `business_unit must be one of ${active.map((u) => u.code).join(', ')}` });
  }
  const businessUnit = bu.code;

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
  const invalid = invalidPatchReason(cleanPatch);
  if (invalid) return res.status(400).json({ error: invalid });
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

  // HR notification (Submit flow) and the candidate's confirmation email.
  // Fire-and-forget: a lookup or Power Automate problem is logged and must
  // never fail the candidate's submission (see lib/submissionEmails.js).
  sendSubmissionEmails(submittedApp).catch((err) => console.error('submit emails failed:', err.message)); // eslint-disable-line no-console

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
