'use strict';

// ============================================================================
// Candidate-facing emails built on the server (same look as every other
// server email — see offboarding/mailer.js layout()) and sent through the one
// generic Power Automate email flow (POWER_AUTOMATE_URL_OFFBOARDING_EMAIL).
// The flow's "From" decides the sender: point it at the HR shared mailbox.
// ============================================================================

const mailer = require('./offboarding/mailer');
const { sendOffboardingEmail } = require('./powerAutomate');

const frontend = () => (process.env.FRONTEND_BASE_URL || 'https://hrforms.wct.my').replace(/\/+$/, '');

/** Send one simple email in the standard layout. Resolves { ok, status }; never throws. */
function simpleEmail({ area, eyebrow, to, cc = [], subject, heading, intro, rows = [], button, note, eventType, ref }) {
  return sendOffboardingEmail({
    to: [...new Set(to)].join(';'),
    cc: [...new Set(cc)].filter((e) => !to.includes(e)).join(';'),
    subject: `[WCT ${area}] ${subject}`,
    html: mailer.layout({ eyebrow, heading, intro, rows, button, note, area }),
    attachments: [],
    event_type: eventType,
    case_ref: ref || '',
  });
}

/** "Thank you for completing your profile" — sent when a candidate submits. */
function sendApplicationReceived(app, unit) {
  if (!app.email) return Promise.resolve({ ok: false, skipped: 'no_email' });
  const submitted = app.submitted_at ? new Date(app.submitted_at) : new Date();
  return simpleEmail({
    area: 'Recruitment',
    eyebrow: 'Application Received',
    to: [app.email.toLowerCase()],
    subject: `Application received (${app.reference_no})`,
    heading: 'Thank you for completing your profile with WCT Group!',
    intro: `Dear ${mailer.esc(app.name_nric || 'Candidate')},<br><br>Your application has been successfully submitted. We appreciate your interest in joining WCT Group and look forward to meeting you at the interview!`,
    rows: [
      ['Reference no.', app.reference_no],
      ['Position applied for', app.position_applying || '—'],
      ['Business unit', unit ? unit.name : app.business_unit],
      ['Submitted on', submitted.toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' })],
    ],
    button: { label: 'View my application', href: `${frontend()}/index.html` },
    note: 'Please keep your reference number for any enquiries about your application. Our HR team will review it and contact you regarding the next steps.',
    eventType: 'application_received',
    ref: app.reference_no,
  });
}

/** Reminder to a hired candidate whose onboarding details are still missing. */
function sendOnboardingReminder(app, unitName) {
  return simpleEmail({
    area: 'Onboarding',
    eyebrow: 'Onboarding Reminder',
    to: [app.email],
    subject: `Reminder: please complete your onboarding details (${app.reference_no})`,
    heading: 'Your onboarding details are still needed',
    intro: `Dear ${mailer.esc(app.name_nric || 'candidate')},<br><br>Congratulations again on joining WCT. Your onboarding details (statutory, bank, emergency contacts and beneficiary) haven't been completed yet. HR needs them before your first payroll.`,
    rows: [['Reference', app.reference_no], ['Position', app.position_applying || '—'], ['Business unit', unitName || app.business_unit]],
    button: { label: 'Complete my onboarding', href: `${frontend()}/index.html?onboarding=${encodeURIComponent(app.id)}` },
    note: 'You can save your progress and come back any time. If you have already sent these details to HR, please ignore this email.',
    eventType: 'onboarding_reminder',
    ref: app.reference_no,
  });
}

module.exports = { simpleEmail, sendApplicationReceived, sendOnboardingReminder };
