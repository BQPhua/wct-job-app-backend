'use strict';

// ============================================================================
// Emails sent when a candidate submits an application:
//   1. HR: the Submit flow (POWER_AUTOMATE_URL_SUBMIT) emails `notify_email`
//      = the unit's HR admins (or the super admins when the unit has none)
//      plus the unit's PIC email (Business Unit Settings).
//   2. Candidate: "Thank you for completing your profile", built here and
//      sent through the generic email flow when CANDIDATE_CONFIRMATION_EMAIL
//      is on (otherwise the Submit flow's own candidate step, if it still
//      has one, is what emails the candidate).
// Used by POST /api/applications/:id/submit and by
// scripts/check-submit-emails.js (to check or re-send for one application).
// Never throws: a lookup or Power Automate problem is logged and reported in
// the result, and must never fail the candidate's submission.
// ============================================================================

const { notify, sanitizeNotificationPayload } = require('./powerAutomate');
const { getBuAdminEmails } = require('./notificationHelpers');
const businessUnits = require('./businessUnits');
const { sendApplicationReceived } = require('./candidateEmails');

const candidateEmailOn = () => /^(1|on|true|yes)$/i.test(process.env.CANDIDATE_CONFIRMATION_EMAIL || '');

/** Who the HR notification goes to, and the unit row. Never throws. */
async function submissionRecipients(app) {
  let unit = null;
  const emails = [];
  try {
    unit = await businessUnits.get(app.business_unit);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`submit email: could not read business unit ${app.business_unit}: ${err.message}`);
  }
  try {
    emails.push(...await getBuAdminEmails(app.business_unit));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`submit email: could not read HR admins for ${app.business_unit}: ${err.message}`);
  }
  if (unit && unit.pic_email) emails.push(...unit.pic_email.toLowerCase().split(/[;,]\s*/).filter(Boolean));
  return { unit, notifyEmail: [...new Set(emails.map((e) => e.toLowerCase()))].join(';') };
}

/** Send both submission emails for a submitted application row. */
async function sendSubmissionEmails(app) {
  const { unit, notifyEmail } = await submissionRecipients(app);
  const hr = await notify('submit', sanitizeNotificationPayload({
    ...app,
    business_unit_name: unit ? unit.name : app.business_unit,
    notify_email: notifyEmail,
  }));
  let candidate = { ok: false, skipped: 'switched_off' };
  if (candidateEmailOn()) {
    candidate = await sendApplicationReceived(app, unit).catch((err) => ({ ok: false, error: err.message }));
  }
  if (hr && !hr.ok) {
    // eslint-disable-next-line no-console
    console.error(`submit email: HR notification for ${app.reference_no} not sent (${hr.skipped || hr.error || `HTTP ${hr.status}`})`);
  }
  if (candidateEmailOn() && !candidate.ok) {
    // eslint-disable-next-line no-console
    console.error(`submit email: candidate confirmation for ${app.reference_no} not sent (${candidate.skipped || candidate.error || `HTTP ${candidate.status}`})`);
  }
  return { notifyEmail, unitName: unit ? unit.name : app.business_unit, hr, candidate };
}

module.exports = { sendSubmissionEmails, submissionRecipients, candidateEmailOn };
