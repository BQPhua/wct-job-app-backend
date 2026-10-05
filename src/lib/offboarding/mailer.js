'use strict';

// ============================================================================
// Offboarding emails: who gets each one, what it says, and sending it
// through the single "WCT Offboarding Email" Power Automate flow
// (powerAutomate.sendOffboardingEmail).
//
// send(eventType, bundle, extra) never throws; it resolves
//   { ok, results: [{ department_id?, ok, to }] }
// so callers can record failures (routes) or retry later (reminder job).
//
// Recipient rules (spec §6):
//   HR               = active bu_admins of the case's BU (→ super admins
//                      when the BU has none — getBuAdminEmails fallback)
//   department task  = Reporting Unit → the assigned superior if set;
//                      otherwise that BU's clearance PICs for the
//                      department; → HR when nobody holds that role, so a
//                      task is never silently dropped
//   payroll          = the Payroll PICs (group-wide; → HR when none), HR in cc
// ============================================================================

const db = require('../../db');
const { sendOffboardingEmail } = require('../powerAutomate');
const { getBuAdminEmails } = require('../notificationHelpers');
const pdf = require('./pdf');

const frontend = () => process.env.FRONTEND_BASE_URL || 'https://bqphua.github.io/job-app';
const employeeLink = (c) => `${frontend()}/index.html?offboard=${encodeURIComponent(c.invite_token)}`;
const staffLink = (c) => `${frontend()}/admin.html?offboarding=${encodeURIComponent(c.id)}`;

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso) {
  if (!iso) return '—';
  const s = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  return `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
}
const lastDay = (c) => c.actual_last_day || c.official_last_day;

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------
async function roleEmails(role, bu, departmentId = null) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.email
       FROM admin_grants g
       JOIN admin_users u ON u.id = g.admin_user_id
      WHERE g.role = $1 AND (g.business_unit = $2 OR g.role = 'payroll_pic') AND u.is_active = true
        AND ($3::int IS NULL OR g.department_id = $3)
      ORDER BY u.email`,
    [role, bu, departmentId]
  );
  return rows.map((r) => r.email);
}

async function sectionRecipients(caseRow, section) {
  if (section.assignee_email) return [section.assignee_email.toLowerCase()];
  // Reporting Unit with no superior on file (only possible on cases migrated
  // from the old system): HR, who can add the superior or sign on behalf.
  if (section.department_id === 1) return getBuAdminEmails(caseRow.business_unit);
  const pics = await roleEmails('clearance_pic', caseRow.business_unit, section.department_id);
  return pics.length ? pics : getBuAdminEmails(caseRow.business_unit);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
function layout({ heading, intro, rows = [], button, note, area = 'Offboarding' }) {
  const detail = rows.length ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px">
        ${rows.map(([k, v]) => `<tr>
          <td style="padding:7px 12px;background:#F7F7F6;border:1px solid #E4E4E3;color:#6E6E6D;width:38%">${esc(k)}</td>
          <td style="padding:7px 12px;border:1px solid #E4E4E3;color:#1A1A1A">${esc(v)}</td></tr>`).join('')}
      </table>` : '';
  const btn = button ? `
      <p style="margin:24px 0">
        <a href="${esc(button.href)}" style="background:#3E5C76;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(button.label)}</a>
      </p>
      <p style="font-size:12px;color:#6E6E6D;margin:0 0 8px">If the button doesn't work, copy this link into your browser:<br>
        <span style="word-break:break-all">${esc(button.href)}</span></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#F7F7F6;font-family:Segoe UI,Arial,sans-serif;color:#1A1A1A">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F6;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #E4E4E3;border-radius:10px;overflow:hidden">
        <tr><td style="background:#101B2D;color:#ffffff;padding:18px 28px;font-size:13px;letter-spacing:.06em;text-transform:uppercase">WCT Group · HR &amp; Admin · ${esc(area)}</td></tr>
        <tr><td style="padding:28px">
          <h1 style="font-size:20px;margin:0 0 12px;color:#101B2D">${esc(heading)}</h1>
          <p style="font-size:15px;line-height:1.55;margin:0">${intro}</p>
          ${detail}${btn}
          ${note ? `<p style="font-size:13px;color:#6E6E6D;line-height:1.5;margin:16px 0 0">${note}</p>` : ''}
        </td></tr>
        <tr><td style="padding:14px 28px;border-top:1px solid #E4E4E3;font-size:12px;color:#6E6E6D">This is an automated message from the WCT Job Application &amp; Offboarding system. Please do not reply to this email.</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

const caseRows = (c, extra = []) => [
  ['Reference', c.ref_no],
  ['Employee', c.employee_name],
  ['Position', c.position || '—'],
  ['Department', c.department || '—'],
  ['Business unit', c.business_unit],
  ['Last working day', fmtDate(lastDay(c))],
  ...extra,
];

// Each builder: (bundle, extra, section?) → { subject, heading, intro, rows, button, note }
const TEMPLATES = {
  invite: ({ case: c }) => ({
    subject: `Action required: complete your Exit Interview (${c.ref_no})`,
    heading: 'Please complete your Exit Interview',
    intro: `Dear ${esc(c.employee_name)},<br><br>HR has started your offboarding. Please sign in with <b>${esc(c.employee_email)}</b> and complete your Exit Interview. It takes about 5 minutes and you can save a draft.`,
    rows: caseRows(c),
    button: { label: 'Open my offboarding', href: employeeLink(c) },
    note: 'Use this same email address to sign in (Microsoft sign-in is easiest for WCT staff). The link only works for you.',
  }),
  submitted_hr: ({ case: c }) => ({
    subject: `Exit Interview submitted — ${c.employee_name} (${c.ref_no})`,
    heading: 'Exit Interview submitted',
    intro: `${esc(c.employee_name)} has submitted their Exit Interview. Department clearance has started and each department has been notified.`,
    rows: caseRows(c),
    button: { label: 'View case', href: staffLink(c) },
  }),
  clearance_task: ({ case: c }, extra, s) => ({
    subject: `Exit clearance needed: ${s.department_name} — ${c.employee_name} (${c.ref_no})`,
    heading: `${s.department_name} clearance needed`,
    intro: `Please complete the <b>${esc(s.department_name)}</b> exit clearance checklist for ${esc(c.employee_name)} before their last working day.`,
    rows: caseRows(c),
    button: { label: 'Open checklist', href: staffLink(c) },
  }),
  reminder: ({ case: c }, extra, s) => ({
    subject: `Reminder: ${s.department_name} clearance for ${c.employee_name} — ${extra.daysLeft != null ? `${extra.daysLeft} day(s) left` : 'pending'} (${c.ref_no})`,
    heading: `Reminder: ${s.department_name} clearance pending`,
    intro: `The <b>${esc(s.department_name)}</b> exit clearance for ${esc(c.employee_name)} is still pending${extra.daysLeft != null ? ` and their last working day is in <b>${esc(extra.daysLeft)} day(s)</b>` : ''}.`,
    rows: caseRows(c),
    button: { label: 'Open checklist', href: staffLink(c) },
  }),
  ready_to_ack: ({ case: c }) => ({
    subject: `Please acknowledge your exit clearance (${c.ref_no})`,
    heading: 'Your exit clearance is ready',
    intro: `Dear ${esc(c.employee_name)},<br><br>All six departments have completed your exit clearance. Please review the result and acknowledge it so Payroll can process your final pay.`,
    rows: caseRows(c),
    button: { label: 'Review and acknowledge', href: employeeLink(c) },
  }),
  payroll_action: ({ case: c }, extra) => ({
    subject: `Offboarding complete — payroll action needed: ${c.employee_name} (${c.ref_no})`,
    heading: 'Payroll action needed',
    intro: `${esc(c.employee_name)} has acknowledged their exit clearance. Please process the final pay, then open the case and click <b>Mark payroll done</b>.`,
    rows: caseRows(c, [['Acknowledged on', fmtDate(c.acknowledged_at)]]),
    button: { label: 'Open case', href: staffLink(c) },
    note: extra.pdfFailed
      ? 'The PDF forms could not be attached this time — please download them from the case page.'
      : 'The Exit Interview Form and Exit Clearance Form are attached.',
  }),
  payroll_hold: ({ case: c }, extra) => ({
    subject: `Hold final pay: clearance reopened for ${c.employee_name} (${c.ref_no})`,
    heading: 'Please hold the final pay',
    intro: `HR has reopened the <b>${esc(extra.department || 'a department')}</b> clearance for ${esc(c.employee_name)}${extra.reason ? ` (${esc(extra.reason)})` : ''}. Please don't process the final pay yet — you'll receive a new "payroll action needed" email once the employee acknowledges again.`,
    rows: caseRows(c),
    button: { label: 'Open case', href: staffLink(c) },
  }),
  // Automatic follow-ups from the daily reminder run (routes/offboardingCron.js).
  invite_reminder: ({ case: c }, extra) => ({
    subject: `Reminder: please complete your Exit Interview (${c.ref_no})`,
    heading: 'Your Exit Interview is still waiting',
    intro: `Dear ${esc(c.employee_name)},<br><br>HR started your offboarding ${esc(extra.daysSince)} days ago and your Exit Interview hasn't been submitted yet. Please complete it so the departments can start your clearance before your last working day.`,
    rows: caseRows(c),
    button: { label: 'Complete my Exit Interview', href: employeeLink(c) },
    note: `Sign in with <b>${esc(c.employee_email)}</b>. If you have already left or something is wrong, please contact HR.`,
  }),
  ack_reminder: ({ case: c }, extra) => ({
    subject: `Reminder: please acknowledge your exit clearance (${c.ref_no})`,
    heading: 'Your acknowledgement is needed',
    intro: `Dear ${esc(c.employee_name)},<br><br>Your exit clearance was completed ${esc(extra.daysSince)} days ago. Payroll can only process your final pay after you review and acknowledge it.`,
    rows: caseRows(c),
    button: { label: 'Review and acknowledge', href: employeeLink(c) },
  }),
  payroll_reminder: ({ case: c }, extra) => ({
    subject: `Reminder: final pay still pending — ${c.employee_name} (${c.ref_no})`,
    heading: 'Final pay still pending',
    intro: `${esc(c.employee_name)} acknowledged their exit clearance ${esc(extra.daysSince)} days ago, but payroll hasn't been marked done yet. Once the final pay is processed, open the case and click <b>Mark payroll done</b>.`,
    rows: caseRows(c, [['Acknowledged on', fmtDate(c.acknowledged_at)]]),
    button: { label: 'Open case', href: staffLink(c) },
    note: 'The Exit Interview and Exit Clearance PDFs can be downloaded from the case page.',
  }),
  completed: ({ case: c }) => ({
    subject: `Your offboarding is complete (${c.ref_no})`,
    heading: 'Offboarding complete',
    intro: `Dear ${esc(c.employee_name)},<br><br>Payroll has completed your final pay processing and your offboarding with WCT is now complete. Thank you for your contributions, and we wish you all the best.`,
    rows: caseRows(c, [['Completed on', fmtDate(c.payroll_completed_at)]]),
    button: { label: 'Download my forms', href: employeeLink(c) },
  }),
  cancelled: ({ case: c }) => ({
    subject: `Offboarding cancelled (${c.ref_no})`,
    heading: 'Offboarding cancelled',
    intro: `Dear ${esc(c.employee_name)},<br><br>HR has cancelled this offboarding case. No further action is needed from you. If you think this is a mistake, please contact HR.`,
    rows: caseRows(c, [['Reason', c.cancel_reason || '—']]),
  }),
};
// Re-sent invites use the same wording.
TEMPLATES.invite_resent = TEMPLATES.invite;

const PER_SECTION = new Set(['clearance_task', 'reminder']);

async function recipientsFor(eventType, bundle) {
  const c = bundle.case;
  const hr = () => getBuAdminEmails(c.business_unit);
  switch (eventType) {
    case 'invite': case 'invite_resent': case 'ready_to_ack': case 'invite_reminder': case 'ack_reminder':
      return { to: [c.employee_email], cc: [] };
    case 'submitted_hr':
      return { to: await hr(), cc: [] };
    case 'payroll_action': {
      const pay = await roleEmails('payroll_pic', c.business_unit);
      const hrList = await hr();
      return pay.length ? { to: pay, cc: hrList.filter((e) => !pay.includes(e)) } : { to: hrList, cc: [] };
    }
    case 'payroll_hold': case 'payroll_reminder': {
      const pay = await roleEmails('payroll_pic', c.business_unit);
      const hrList = await hr();
      return pay.length ? { to: pay, cc: hrList.filter((e) => !pay.includes(e)) } : { to: hrList, cc: [] };
    }
    case 'completed': case 'cancelled':
      return { to: [c.employee_email], cc: await hr() };
    default:
      throw new Error(`Unknown offboarding email type "${eventType}"`);
  }
}

async function post(eventType, bundle, content, to, cc, attachments = [], extraFields = {}) {
  const payload = {
    to: [...new Set(to)].join(';'),
    cc: [...new Set(cc)].join(';'),
    subject: `[WCT Offboarding] ${content.subject}`,
    html: layout(content),
    attachments,
    event_type: eventType,
    case_ref: bundle.case.ref_no,
    ...extraFields,
  };
  return sendOffboardingEmail(payload);
}

async function send(eventType, bundle, extra = {}) {
  try {
    const tpl = TEMPLATES[eventType];
    if (!tpl) throw new Error(`Unknown offboarding email type "${eventType}"`);

    if (PER_SECTION.has(eventType)) {
      const wanted = extra.departmentIds ? new Set(extra.departmentIds.map(Number)) : null;
      const sections = bundle.sections.filter((s) => s.status === 'pending' && (!wanted || wanted.has(s.department_id)));
      const results = [];
      for (const s of sections) {
        const to = await sectionRecipients(bundle.case, s);
        const r = await post(eventType, bundle, tpl(bundle, extra, s), to, [], [], { department: s.department_name });
        results.push({ department_id: s.department_id, ok: r.ok, to });
      }
      return { ok: results.length > 0 && results.every((r) => r.ok), results };
    }

    const { to, cc } = await recipientsFor(eventType, bundle);
    let attachments = [];
    let pdfFailed = false;
    if (eventType === 'payroll_action') {
      try {
        const [ei, cl] = await Promise.all([pdf.exitInterviewPdf(bundle), pdf.clearancePdf(bundle)]);
        attachments = [
          { name: `Exit-Interview-${bundle.case.ref_no}.pdf`, content_base64: ei.toString('base64') },
          { name: `Exit-Clearance-${bundle.case.ref_no}.pdf`, content_base64: cl.toString('base64') },
        ];
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('offboarding mailer: PDF generation failed, sending without attachments:', err.message);
        pdfFailed = true;
      }
    }
    const r = await post(eventType, bundle, tpl(bundle, { ...extra, pdfFailed }), to, cc, attachments);
    return { ok: r.ok, results: [{ ok: r.ok, to }] };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`offboarding mailer: "${eventType}" failed:`, err.message);
    return { ok: false, results: [], error: err.message };
  }
}

module.exports = { send, fmtDate, esc, layout };
