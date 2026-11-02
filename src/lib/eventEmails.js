'use strict';

// ============================================================================
// Recruitment and admin emails, built on the server in the one standard
// layout (offboarding/mailer.js layout(), the "Thank you for completing your
// profile" look) and sent through the generic email flow
// (POWER_AUTOMATE_URL_OFFBOARDING_EMAIL). 3 Nov 2026: replaces the separate
// Power Automate flows (Submit, Status Change, BU Transfer, Onboarding
// Completion, Admin Invite, Admin Permission Changes), which each had their
// own older design and showed business unit codes ("Land") instead of names
// ("Property Development").
//
// EVENT_EMAILS_VIA_FLOWS=on in /etc/wct/backend.env switches back to the old
// flows (their URLs are still read), in case they are ever needed again.
//
// Every function resolves { ok, status, skipped? } and never throws.
// ============================================================================

const mailer = require('./offboarding/mailer');
const { notify, sanitizeNotificationPayload } = require('./powerAutomate');
const { simpleEmail } = require('./candidateEmails');
const businessUnits = require('./businessUnits');

const flowsOn = () => /^(1|on|true|yes)$/i.test(process.env.EVENT_EMAILS_VIA_FLOWS || '');
const frontend = () => (process.env.FRONTEND_BASE_URL || 'https://hrforms.wct.my').replace(/\/+$/, '');
const adminLink = (appId) => `${frontend()}/admin.html${appId ? `?app=${encodeURIComponent(appId)}` : ''}`;
const esc = mailer.esc;
const list = (emails) => [...new Set(String(Array.isArray(emails) ? emails.join(';') : (emails || ''))
  .split(/[;,]\s*/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
const when = (d) => (d ? new Date(d) : new Date()).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' });

async function unitName(code) {
  if (!code) return '';
  try { return (await businessUnits.nameMap())[code] || code; } catch (e) { return code; }
}
const safe = (p) => Promise.resolve(p).catch((err) => ({ ok: false, status: 0, error: err.message || String(err) }));
const nobody = { ok: false, status: 0, skipped: 'no_recipients' };

/** HR: a candidate has submitted an application. */
async function sendNewApplicationToHr(app, unit, notifyEmail) {
  const name = unit ? unit.name : await unitName(app.business_unit);
  if (flowsOn()) return notify('submit', sanitizeNotificationPayload({ ...app, business_unit_name: name, notify_email: notifyEmail }));
  const to = list(notifyEmail);
  if (!to.length) return nobody;
  return safe(simpleEmail({
    area: 'Recruitment',
    eyebrow: 'New Application',
    to,
    subject: `New job application: ${app.name_nric || 'Candidate'} (${app.reference_no})`,
    heading: 'A new application has been submitted',
    intro: `<b>${esc(app.name_nric || 'A candidate')}</b> has submitted an application for <b>${esc(app.position_applying || 'a position')}</b> with ${esc(name)}.`,
    rows: [
      ['Reference no.', app.reference_no],
      ['Candidate', app.name_nric || '—'],
      ['Position applied for', app.position_applying || '—'],
      ['Business unit', name],
      ['Email', app.email || '—'],
      ['Mobile', app.mobile_phone || '—'],
      ['Submitted on', when(app.submitted_at)],
    ],
    button: { label: 'Open in Admin Dashboard', href: adminLink(app.id) },
    note: 'You are receiving this because you are an HR admin or the person in charge for this business unit.',
    eventType: 'application_submitted_hr',
    ref: app.reference_no,
  }));
}

/** Candidate: their status changed. Only "hired" is emailed. */
async function sendStatusChange(app, notifyEmail) {
  const name = await unitName(app.business_unit);
  if (flowsOn()) {
    return notify('status_change', sanitizeNotificationPayload({
      ...app, notify_email: notifyEmail, business_unit_name: name,
      business_unit: name, // the old hired email shows this field
    }));
  }
  if (app.status !== 'hired') return { ok: false, status: 0, skipped: 'not_emailed' };
  if (!app.email) return { ok: false, status: 0, skipped: 'no_email' };
  return safe(simpleEmail({
    area: 'Recruitment',
    eyebrow: 'Congratulations',
    to: [app.email.toLowerCase()],
    subject: `Congratulations, you've been hired (${app.reference_no})`,
    heading: 'Welcome to WCT Group!',
    intro: `Dear ${esc(app.name_nric || 'Candidate')},<br><br>We're pleased to confirm you've been hired to join WCT Group. Please sign in to the portal to complete your onboarding details: your statutory details, family details, emergency contacts and salary crediting information.`,
    rows: [
      ['Reference no.', app.reference_no],
      ['Position', app.position_applying || '—'],
      ['Business unit', name],
    ],
    button: { label: 'Complete your onboarding', href: `${frontend()}/index.html?onboarding=${encodeURIComponent(app.id)}` },
    note: 'You can save your progress and come back any time. Our HR team will contact you about your first day.',
    eventType: 'hired',
    ref: app.reference_no,
  }));
}

/** New unit's HR: an application was transferred to them. */
async function sendTransfer(app, fromCode, notifyEmail) {
  const [toName, fromName] = await Promise.all([unitName(app.business_unit), unitName(fromCode)]);
  if (flowsOn()) {
    return notify('bu_transfer', sanitizeNotificationPayload({
      ...app, notify_email: notifyEmail, from_business_unit: fromCode || '',
      business_unit_name: toName, from_business_unit_name: fromName,
    }));
  }
  const to = list(notifyEmail);
  if (!to.length) return nobody;
  return safe(simpleEmail({
    area: 'Recruitment',
    eyebrow: 'Application Transferred',
    to,
    subject: `Application transferred to ${toName}: ${app.name_nric || 'Candidate'} (${app.reference_no})`,
    heading: `An application has been transferred to ${toName}`,
    intro: `<b>${esc(app.name_nric || 'A candidate')}</b>'s application has been moved from <b>${esc(fromName || '—')}</b> to <b>${esc(toName)}</b> and is now with your team.`,
    rows: [
      ['Reference no.', app.reference_no],
      ['Candidate', app.name_nric || '—'],
      ['Position applied for', app.position_applying || '—'],
      ['From', fromName || '—'],
      ['To', toName],
    ],
    button: { label: 'Open in Admin Dashboard', href: adminLink(app.id) },
    eventType: 'bu_transfer',
    ref: app.reference_no,
  }));
}

/** HR: a new hire finished their onboarding details. */
async function sendOnboardingCompleted(app, record, notifyEmail) {
  const name = await unitName(app.business_unit);
  if (flowsOn()) {
    return notify('onboarding_complete', sanitizeNotificationPayload({
      ...record, notify_email: notifyEmail, reference_no: app.reference_no || '', name_nric: app.name_nric || '',
      business_unit: app.business_unit || '', business_unit_name: name,
    }));
  }
  const to = list(notifyEmail);
  if (!to.length) return nobody;
  return safe(simpleEmail({
    area: 'Onboarding',
    eyebrow: 'Onboarding Completed',
    to,
    subject: `Onboarding completed: ${app.name_nric || 'New hire'} (${app.reference_no})`,
    heading: 'Onboarding details completed',
    intro: `<b>${esc(app.name_nric || 'The new hire')}</b> has completed and signed their onboarding details. You can view them and download the PDF from the Admin Dashboard.`,
    rows: [
      ['Reference no.', app.reference_no],
      ['Employee', app.name_nric || '—'],
      ['Position', app.position_applying || '—'],
      ['Business unit', name],
      ['Completed on', when(record && record.updated_at)],
    ],
    button: { label: 'View onboarding details', href: adminLink(app.id) },
    eventType: 'onboarding_complete',
    ref: app.reference_no,
  }));
}

/** New admin: invited to the Admin Dashboard. */
async function sendAdminInvite({ email, name, invitedBy }) {
  if (flowsOn()) {
    return notify('invite_admin', { invited_email: email, invited_name: name || '', invited_by_name: invitedBy || 'A Super Admin', admin_login_link: `${frontend()}/admin.html` });
  }
  if (!email) return nobody;
  return safe(simpleEmail({
    area: 'Admin',
    eyebrow: 'Admin Dashboard',
    to: [email.toLowerCase()],
    subject: 'You have been invited to the WCT Admin Dashboard',
    heading: "You've been invited to the Admin Dashboard",
    intro: `Dear ${esc(name || email)},<br><br><b>${esc(invitedBy || 'A Super Admin')}</b> has invited you to the WCT Employment Application Portal's Admin Dashboard. Sign in with this email address using your WCT Microsoft account.`,
    rows: [['Email', email]],
    button: { label: 'Open the Admin Dashboard', href: `${frontend()}/admin.html` },
    note: 'You will see the business units and pages your access allows. If you weren\'t expecting this, please contact your Super Admin.',
    eventType: 'admin_invite',
    ref: email,
  }));
}

// Role names with business unit NAMES (not codes) for the emails.
const DEPARTMENTS = { 1: 'Reporting Unit', 2: 'IT', 3: 'Administration', 4: 'Finance', 5: 'Purchasing', 6: 'Human Resources' };
async function roleLabel(role, bu, departmentId) {
  const n = await unitName(bu);
  if (role === 'super_admin') return 'Super Admin';
  if (role === 'bu_admin') return `HR Admin (${n || 'unassigned'})`;
  if (role === 'payroll_pic') return n ? `Payroll PIC (${n})` : 'Payroll PIC (all business units)';
  if (role === 'clearance_pic') return `Clearance PIC: ${DEPARTMENTS[departmentId] || 'Department'} (${n})`;
  return role || '';
}

const PERMISSION_TEXT = {
  grant_added: { eyebrow: 'Access Granted', subject: 'You have been given new access', heading: 'Access granted', verb: (by, r) => `<b>${esc(by)}</b> has given you <b>${esc(r)}</b> access on the WCT Admin Dashboard.` },
  grant_revoked: { eyebrow: 'Access Removed', subject: 'Your access has been removed', heading: 'Access removed', verb: (by, r) => `<b>${esc(by)}</b> has removed your <b>${esc(r)}</b> access on the WCT Admin Dashboard. If you believe this is a mistake, please contact your Super Admin.` },
  deactivated: { eyebrow: 'Account Deactivated', subject: 'Your Admin Dashboard account has been deactivated', heading: 'Account deactivated', verb: (by) => `<b>${esc(by)}</b> has deactivated your access to the WCT Admin Dashboard. Contact your Super Admin if you have questions.` },
  reactivated: { eyebrow: 'Access Reactivated', subject: 'Your Admin Dashboard access has been reactivated', heading: 'Access reactivated', verb: (by, r) => `<b>${esc(by)}</b> has reactivated your access to the WCT Admin Dashboard${r ? ` (<b>${esc(r)}</b>)` : ''}.` },
};

/**
 * Admin: their access changed. grants: [{ role, business_unit, department_id }]
 * (one for an added/removed role; all current roles for (re)activation).
 */
async function sendPermissionChange({ eventType, email, name, grants = [], changedBy, legacyRoleLabel }) {
  const labels = (await Promise.all(grants.map((g) => roleLabel(g.role, g.business_unit, g.department_id)))).join(', ');
  if (flowsOn()) {
    return notify('admin_permission_change', {
      event_type: eventType, target_email: email, target_name: name || email,
      role: grants.map((g) => g.role).join(','), business_unit: grants.map((g) => g.business_unit).filter(Boolean).join(','),
      role_label: labels || legacyRoleLabel || '', changed_by_name: changedBy || 'A Super Admin',
      admin_login_link: `${frontend()}/admin.html`,
    });
  }
  const t = PERMISSION_TEXT[eventType];
  if (!t || !email) return nobody;
  return safe(simpleEmail({
    area: 'Admin',
    eyebrow: t.eyebrow,
    to: [email.toLowerCase()],
    subject: t.subject,
    heading: t.heading,
    intro: `Dear ${esc(name || email)},<br><br>${t.verb(changedBy || 'A Super Admin', labels)}`,
    rows: [['Account', email], ...(labels ? [[eventType === 'deactivated' ? 'Access before' : 'Access', labels]] : [])],
    button: eventType === 'deactivated' || eventType === 'grant_revoked' ? undefined : { label: 'Open the Admin Dashboard', href: `${frontend()}/admin.html` },
    eventType: `admin_${eventType}`,
    ref: email,
  }));
}

module.exports = {
  flowsOn, sendNewApplicationToHr, sendStatusChange, sendTransfer, sendOnboardingCompleted,
  sendAdminInvite, sendPermissionChange, roleLabel,
};
