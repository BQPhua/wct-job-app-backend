'use strict';

// ============================================================================
// AI Insights (spec §8) — full implementation.
//
// The product owner confirmed (2026-09-11) this is "a fully working feature"
// in the reference app, not a deferred stub, and that its Gemini API key was
// stored as a Supabase Edge Function secret. Reverse-engineered verbatim from
// the original `ai-analytics` Supabase Edge Function (index.ts, Deno
// runtime) via the Supabase dashboard's Code viewer on 2026-09-11 — the
// original four `mode` branches ('summary', 'chat', 'recommend', 'document')
// and the Gemini REST call below are byte-for-byte copies of that source,
// translated from Deno/`Deno.serve` to an Express route. A fifth mode,
// 'candidate_qa', was added later (see the 2026-09-15 follow-up note below)
// and has no equivalent in the original Edge Function.
//
// Auth model translation: the original function checked (a) a valid
// Supabase Auth session, then (b) `rpc_check_admin_active()` (an active
// `admin_users` row linked to that session). Here `requireAdminAuth`
// (src/middleware/auth.js) already proves both — a valid admin session JWT
// can only ever have been minted for an active admin_users row (see
// routes/admin.js `/auth/session`) — so no extra DB check is needed here.
//
// One deliberate content change from the original: the 'document' mode
// prompt used to interpolate `data?.position_applying` ("for the position of
// ..."). That field was removed application-wide 2026-09-11 (see
// db/migrations/002_position_applying_and_refno.sql), so at that point this
// implementation dropped the clause entirely rather than referencing a
// column that no longer existed.
//
// Follow-up (2026-09-15): with no position/role field left on an
// application at all, 'recommend' and 'document' instead accepted an
// optional, freely-typed `data.role_description` — the admin describes the
// role/requirements per lookup in the AI Candidate Review UI (admin.html),
// and the prompt weighs its answer against that specific text when present.
// A new 'candidate_qa' mode was also added alongside 'recommend': open-ended
// Q&A scoped to one candidate (e.g. "Is this person the best fit for this
// role?"), reusing the exact same non-PII candidate payload and the same
// role_description convention.
//
// Follow-up (2026-09-17): `position_applying` is BACK (product owner
// reversed the 2026-09-11 decision — see
// db/migrations/004_re_add_position_applying.sql). It's now included
// automatically in every candidate-scoped payload admin.html sends
// (`recommend`, `candidate_qa`, `document`) as `data.position_applying` —
// the position the candidate said they're applying for. This is distinct
// from `data.role_description`, which stays as the admin's own free-typed
// hiring requirements for that lookup; both can be present at once, and the
// prompts below reference each one for what it actually is.
//
// GEMINI_API_KEY: Supabase only ever shows a SHA-256 digest of an Edge
// Function secret, never the plaintext value, once set — confirmed via the
// Secrets tab (2026-09-11). The real key could not be recovered from the old
// project and must be supplied fresh (or a new key generated at
// https://aistudio.google.com/apikey) and set as GEMINI_API_KEY in this
// backend's environment.
// ============================================================================

const express = require('express');
const asyncHandler = require('../lib/asyncHandler');
const { requireAdminAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdminAuth);

const SUPPORTED_MODES = ['summary', 'chat', 'recommend', 'candidate_qa', 'document'];
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

// POST /api/admin/ai-insights  { mode: 'summary'|'chat'|'recommend'|'candidate_qa'|'document', ... }
router.post('/', asyncHandler(async (req, res) => {
  const { mode, data, question, history, fileBase64, mimeType } = req.body || {};
  if (!SUPPORTED_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of ${SUPPORTED_MODES.join(', ')}` });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI Insights is not configured: GEMINI_API_KEY is not set' });
  }

  let prompt;
  let requestParts;

  if (mode === 'summary') {
    prompt =
      'You are an HR analytics assistant for a Malaysian construction/property group. ' +
      'Given this aggregated, ANONYMIZED hiring data (plain counts and percentages — no ' +
      'candidate-level information), write a short, plain-language summary (3-5 sentences) ' +
      'highlighting the most notable trends. Do not invent numbers that are not present in ' +
      'the data, and do not speculate about individual people.\n\n' +
      'Data:\n' + JSON.stringify(data);
    requestParts = [{ text: prompt }];
  } else if (mode === 'chat') {
    const historyText = (history || [])
      .map((h) => `${h.role}: ${h.content}`)
      .join('\n');
    prompt =
      'You are an HR analytics assistant for WCT Group. You can see a list of job ' +
      'applications identified ONLY by their reference number (e.g. WCT-EC-2026-000123) — you ' +
      "are never given anyone's real name, NRIC, email, phone, or address. Answer the " +
      "admin's question using ONLY the data below. If the question asks for a candidate's " +
      'name or other personal details, explain that this view intentionally does not include ' +
      'that, and suggest looking up the reference number in the dashboard search instead. If ' +
      "the data doesn't contain something needed to answer, say so rather than guessing.\n\n" +
      'Data:\n' + JSON.stringify(data) + '\n\n' +
      (historyText ? historyText + '\n' : '') +
      'Question: ' + question;
    requestParts = [{ text: prompt }];
  } else if (mode === 'recommend') {
    prompt =
      "You are an HR screening assistant for WCT Group. Based ONLY on this candidate's " +
      'application details (identified only by reference number — you are not given their ' +
      'name or contact details), recommend ONE status from exactly these options: ' +
      '"Shortlist", "KIV" (keep in view), or "Reject". ' +
      "If the candidate data below includes a `position_applying` field, that's the position " +
      "this candidate applied for — keep it in mind as context for what role they're being " +
      "considered for. If it also includes a `role_description` field, weigh the recommendation " +
      'specifically against those stated requirements — call out where the candidate does or ' +
      "doesn't meet them. If `role_description` is absent or empty, judge general employability " +
      'based on qualifications, experience, and stated expectations instead (using ' +
      '`position_applying`, if present, only as general context, not as a requirements spec), ' +
      "and don't assume requirements that weren't actually given. " +
      'Start your response with "Recommendation: <status>" on its own line, then a short ' +
      '(3-5 sentence) justification referencing specific details from the data. Do not invent ' +
      'qualifications, experience, or details not present in the data. This is a recommendation ' +
      'for a human to review, not a final decision.\n\n' +
      'Candidate data:\n' + JSON.stringify(data);
    requestParts = [{ text: prompt }];
  } else if (mode === 'candidate_qa') {
    if (!question) return res.status(400).json({ error: 'Missing question' });
    const historyText = (history || [])
      .map((h) => `${h.role}: ${h.content}`)
      .join('\n');
    prompt =
      "You are an HR screening assistant for WCT Group. Answer the admin's question about ONE " +
      'specific candidate, using ONLY the application details below (identified only by ' +
      'reference number — you are not given their name or contact details). ' +
      "A `position_applying` field, if included, is the position this candidate applied for. " +
      "If a `role_description` field is also included, treat it as the role the admin is hiring " +
      'for and weigh your answer against it explicitly — e.g. if asked whether this candidate is ' +
      'the best fit for the role, judge fit against those stated requirements specifically, not ' +
      "in the abstract. If `role_description` is absent, answer based on general employability " +
      "instead (treating `position_applying`, if present, as context only) and say plainly that " +
      'no specific role/requirements were given. Do not invent ' +
      'qualifications, experience, or details not present in the data. This is input for a ' +
      'human reviewer, not a final decision.\n\n' +
      'Candidate data:\n' + JSON.stringify(data) + '\n\n' +
      (historyText ? historyText + '\n' : '') +
      'Question: ' + question;
    requestParts = [{ text: prompt }];
  } else if (mode === 'document') {
    if (!fileBase64 || !mimeType) return res.status(400).json({ error: 'Missing file data' });
    const positionApplying = data && data.position_applying ? String(data.position_applying).trim() : '';
    const roleDescription = data && data.role_description ? String(data.role_description).trim() : '';
    prompt =
      'You are an HR assistant for WCT Group. Analyze this candidate document (e.g. resume/CV ' +
      'or supporting attachment). Summarize key qualifications, relevant experience, and ' +
      'skills. Note anything that seems inconsistent or worth a human double-checking. Do not ' +
      'fabricate information not actually present in the document.' +
      (positionApplying ? ` This candidate applied for the position of "${positionApplying}".` : '') +
      (roleDescription
        ? ' The admin is hiring for the following role — also note how well this document ' +
          `aligns with it, and flag any obvious gaps: "${roleDescription}"`
        : '');
    requestParts = [{ text: prompt }, { inline_data: { mime_type: mimeType, data: fileBase64 } }];
  } else {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: requestParts }] }),
    }
  );
  const geminiData = await geminiRes.json();
  if (!geminiRes.ok) {
    return res.status(502).json({ error: (geminiData && geminiData.error && geminiData.error.message) || 'AI provider error' });
  }

  const text =
    (geminiData &&
      geminiData.candidates &&
      geminiData.candidates[0] &&
      geminiData.candidates[0].content &&
      geminiData.candidates[0].content.parts &&
      geminiData.candidates[0].content.parts[0] &&
      geminiData.candidates[0].content.parts[0].text) ||
    'No response generated.';

  return res.json({ text });
}));

module.exports = router;
