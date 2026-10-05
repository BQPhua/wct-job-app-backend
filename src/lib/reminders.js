'use strict';

// ============================================================================
// Follow-up reminders, sent by the same daily run as the clearance reminders
// (POST /api/offboarding/cron/reminders, triggered every morning by the
// "WCT Offboarding Daily Reminder" Power Automate flow). Every email goes
// through the existing generic "WCT Offboarding Email" flow, so no new flow
// is needed.
//
//   Exit Interview not submitted   employee        3 and 7 days after invite
//   Acknowledgement not given      employee        2 and 5 days after clearance
//   Final pay not marked done      Payroll PICs    3 and 7 days after ack
//   Onboarding not completed       new hire        3 and 7 days after hire
//   Weekly HR digest (Mondays)     BU HR admins    applications waiting > 3 days
//
// Each reminder is recorded in notification_log only once Power Automate
// accepted it, so a failed send is retried the next day, and nothing is sent
// twice. If migration 007 hasn't been run yet, this whole part is skipped.
// ============================================================================

const db = require('../db');
const mailer = require('./offboarding/mailer');
const lifecycle = require('./offboarding/lifecycle');
const dates = require('./offboarding/dates');
const { sendOffboardingEmail } = require('./powerAutomate');
const { getBuAdminEmails } = require('./notificationHelpers');

const STEPS = {
  invite_reminder: [3, 7],
  ack_reminder: [2, 5],
  payroll_reminder: [3, 7],
  onboarding_reminder: [3, 7],
};
const HR_DIGEST_MIN_DAYS = 3;

const frontend = () => process.env.FRONTEND_BASE_URL || 'https://bqphua.github.io/job-app';
const daysSince = (today, ts) => (ts ? dates.daysBetween(new Date(ts).toISOString().slice(0, 10), today) : null);

async function sentSteps(kind, refKey) {
  const { rows } = await db.query('SELECT step FROM notification_log WHERE kind = $1 AND ref_key = $2', [kind, String(refKey)]);
  return new Set(rows.map((r) => r.step));
}
async function markSent(kind, refKey, step) {
  await db.query('INSERT INTO notification_log (kind, ref_key, step) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [kind, String(refKey), step]);
}
/** The highest due step not yet sent (we never send two at once). */
function dueStep(kind, age, done) {
  const due = STEPS[kind].filter((d) => age >= d && !done.has(d));
  return due.length ? due[due.length - 1] : null;
}

async function offboardingFollowUps(today, stats) {
  const plans = [
    { kind: 'invite_reminder', sql: "SELECT id, invited_at AS since FROM offboarding_cases WHERE status = 'invited'" },
    {
      kind: 'ack_reminder',
      sql: `SELECT c.id, (SELECT max(s.signed_at) FROM offboarding_clearance_sections s WHERE s.case_id = c.id) AS since
              FROM offboarding_cases c WHERE c.status = 'pending_acknowledgement'`,
    },
    { kind: 'payroll_reminder', sql: "SELECT id, acknowledged_at AS since FROM offboarding_cases WHERE status = 'pending_payroll'" },
  ];
  for (const plan of plans) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await db.query(plan.sql);
    for (const r of rows) {
      const age = daysSince(today, r.since);
      if (age == null) continue;
      // eslint-disable-next-line no-await-in-loop
      const step = dueStep(plan.kind, age, await sentSteps(plan.kind, r.id));
      if (step == null) continue;
      // eslint-disable-next-line no-await-in-loop
      const bundle = await lifecycle.loadBundle(db, r.id);
      // eslint-disable-next-line no-await-in-loop
      const res = await mailer.send(plan.kind, bundle, { daysSince: age });
      if (res.ok) {
        for (const d of STEPS[plan.kind].filter((x) => x <= step)) {
          // eslint-disable-next-line no-await-in-loop
          await markSent(plan.kind, r.id, d);
        }
        // eslint-disable-next-line no-await-in-loop
        await lifecycle.logEvent(db, r.id, null, 'reminder_sent', { automatic: true, kind: plan.kind, days_since: age });
        stats.sent += 1;
      } else {
        stats.failed += 1;
      }
    }
  }
}

function simpleEmail({ area, to, cc = [], subject, heading, intro, rows = [], button, note, eventType, ref }) {
  return sendOffboardingEmail({
    to: [...new Set(to)].join(';'),
    cc: [...new Set(cc)].filter((e) => !to.includes(e)).join(';'),
    subject: `[WCT ${area}] ${subject}`,
    html: mailer.layout({ heading, intro, rows, button, note, area }),
    attachments: [],
    event_type: eventType,
    case_ref: ref || '',
  });
}

async function onboardingFollowUps(today, stats) {
  const kind = 'onboarding_reminder';
  const { rows } = await db.query(
    `SELECT a.id, a.reference_no, a.name_nric, a.email, a.business_unit, a.position_applying, a.updated_at
       FROM applications a
       LEFT JOIN onboarding_records o ON o.application_id = a.id
      WHERE a.status = 'hired' AND COALESCE(o.status, 'in_progress') <> 'completed' AND a.email IS NOT NULL`
  );
  for (const a of rows) {
    // eslint-disable-next-line no-await-in-loop
    const done = await sentSteps(kind, a.id);
    // There is no "hired on" date, so the first run that sees a hire records
    // step 0 and counts from there. Hires untouched for over 30 days at that
    // point are old records — never remind those.
    if (!done.has(0)) {
      if (daysSince(today, a.updated_at) > 30) { await markSent(kind, a.id, -1); continue; } // eslint-disable-line no-await-in-loop
      await markSent(kind, a.id, 0); // eslint-disable-line no-await-in-loop
      continue;
    }
    if (done.has(-1)) continue;
    // eslint-disable-next-line no-await-in-loop
    const seen = await db.query('SELECT sent_at FROM notification_log WHERE kind = $1 AND ref_key = $2 AND step = 0', [kind, String(a.id)]);
    const age = daysSince(today, seen.rows[0].sent_at);
    const step = dueStep(kind, age, done);
    if (step == null) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await simpleEmail({
      area: 'Onboarding',
      to: [a.email],
      subject: `Reminder: please complete your onboarding details (${a.reference_no})`,
      heading: 'Your onboarding details are still needed',
      intro: `Dear ${mailer.esc(a.name_nric || 'candidate')},<br><br>Congratulations again on joining WCT. Your onboarding details (statutory, bank, family, emergency contacts and beneficiary) haven't been completed yet. HR needs them before your first payroll.`,
      rows: [['Reference', a.reference_no], ['Position', a.position_applying || '—'], ['Business unit', a.business_unit]],
      button: { label: 'Complete my onboarding', href: `${frontend()}/index.html?onboarding=${encodeURIComponent(a.id)}` },
      note: 'You can save your progress and come back any time. If you have already sent these details to HR, please ignore this email.',
      eventType: kind,
      ref: a.reference_no,
    });
    if (r.ok) {
      for (const d of STEPS[kind].filter((x) => x <= step)) await markSent(kind, a.id, d); // eslint-disable-line no-await-in-loop
      stats.sent += 1;
    } else stats.failed += 1;
  }
}

/** ISO week number as yyyyww, so the digest goes out once per week. */
function isoWeek(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() * 100 + week;
}

async function hrDigest(today, stats) {
  const kind = 'hr_digest';
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return; // Mondays only
  const week = isoWeek(today);
  const { rows } = await db.query(
    `SELECT business_unit, reference_no, name_nric, position_applying, submitted_at
       FROM applications
      WHERE status = 'submitted' AND submitted_at < now() - ($1 || ' days')::interval
      ORDER BY submitted_at`,
    [String(HR_DIGEST_MIN_DAYS)]
  );
  const byBu = {};
  rows.forEach((r) => { (byBu[r.business_unit] = byBu[r.business_unit] || []).push(r); });
  for (const [bu, apps] of Object.entries(byBu)) {
    // eslint-disable-next-line no-await-in-loop
    if ((await sentSteps(kind, bu)).has(week)) continue;
    // eslint-disable-next-line no-await-in-loop
    const to = await getBuAdminEmails(bu);
    if (!to.length) continue;
    const list = apps.slice(0, 15).map((a) => [`${a.name_nric || 'Applicant'} · ${a.reference_no}`, `${a.position_applying || '—'} · waiting ${daysSince(today, a.submitted_at)} days`]);
    // eslint-disable-next-line no-await-in-loop
    const r = await simpleEmail({
      area: 'Recruitment',
      to,
      subject: `${apps.length} application${apps.length === 1 ? '' : 's'} waiting for review — ${bu}`,
      heading: `${apps.length} application${apps.length === 1 ? ' is' : 's are'} waiting for review`,
      intro: `These ${bu} applications were submitted more than ${HR_DIGEST_MIN_DAYS} days ago and are still marked <b>New</b>. Shortlist, keep in view or reject them so candidates hear back.`,
      rows: list,
      button: { label: 'Open the dashboard', href: `${frontend()}/admin.html` },
      note: apps.length > 15 ? `Showing the 15 oldest of ${apps.length}.` : 'You get this summary every Monday while applications are waiting.',
      eventType: kind,
      ref: bu,
    });
    if (r.ok) { await markSent(kind, bu, week); stats.sent += 1; } else stats.failed += 1; // eslint-disable-line no-await-in-loop
  }
}

/** Run every follow-up; never throws. */
async function runFollowUps(today = dates.todayMYT()) {
  const stats = { sent: 0, failed: 0 };
  try {
    await db.query('SELECT 1 FROM notification_log LIMIT 1');
  } catch (err) {
    if (err.code === '42P01') return { ...stats, skipped: 'notification_log table missing — run migration 007' };
    throw err;
  }
  for (const [name, fn] of [['offboarding', offboardingFollowUps], ['onboarding', onboardingFollowUps], ['hr_digest', hrDigest]]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn(today, stats);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`reminders: ${name} failed:`, err.message);
      stats.errors = [...(stats.errors || []), name];
    }
  }
  return stats;
}

module.exports = { runFollowUps, isoWeek, STEPS };
