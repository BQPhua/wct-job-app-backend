'use strict';

// ============================================================================
// POST /api/offboarding/cron/reminders — the daily clearance reminder run.
//
// Called once a day (09:00 MYT): on Azure by the "WCT Offboarding Daily
// Reminder" Power Automate flow (Recurrence → HTTP); on the office Ubuntu
// server by the wct-reminders systemd timer (deploy/install-reminders.sh),
// since the cloud flow can't reach it. Protected by a shared secret in the `x-cron-key`
// header (OFFBOARDING_CRON_SECRET).
//
// Rule (from Qurratu's system): for every case in clearance, days left =
// effective last day − today (MYT). 7..4 days → the "7-day" reminder,
// 3..0 → the "3-day" reminder, once per department each, only for sections
// still pending. A reminder is logged only when Power Automate accepted it,
// so a failed send is retried by the next run. Safe to call repeatedly.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const lifecycle = require('../lib/offboarding/lifecycle');
const mailer = require('../lib/offboarding/mailer');
const dates = require('../lib/offboarding/dates');
const { REMINDER_WINDOWS } = require('../lib/offboarding/constants');
const reminders = require('../lib/reminders');

const router = express.Router();

function keyOk(given) {
  const expected = process.env.OFFBOARDING_CRON_SECRET;
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/reminders', asyncHandler(async (req, res) => {
  if (!keyOk(req.get('x-cron-key'))) return res.status(401).json({ error: 'Invalid cron key' });

  const today = dates.todayMYT();
  const { rows: cases } = await db.query(
    `SELECT id, COALESCE(actual_last_day, official_last_day) AS last_day
       FROM offboarding_cases
      WHERE status = 'clearance_in_progress' AND COALESCE(actual_last_day, official_last_day) IS NOT NULL`
  );

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    const daysLeft = dates.daysBetween(today, c.last_day);
    const window = REMINDER_WINDOWS.find((w) => daysLeft >= w.min && daysLeft <= w.max);
    if (!window) { skipped += 1; continue; }

    // eslint-disable-next-line no-await-in-loop
    const bundle = await lifecycle.loadBundle(db, c.id);
    // eslint-disable-next-line no-await-in-loop
    const logged = await db.query(
      'SELECT department_id FROM offboarding_reminder_log WHERE case_id = $1 AND days_before = $2',
      [c.id, window.days_before]
    );
    const done = new Set(logged.rows.map((r) => r.department_id));
    const due = bundle.sections.filter((s) => s.status === 'pending' && !done.has(s.department_id)).map((s) => s.department_id);
    if (!due.length) { skipped += 1; continue; }

    // eslint-disable-next-line no-await-in-loop
    const r = await mailer.send('reminder', bundle, { departmentIds: due, daysLeft });
    const okIds = r.results.filter((x) => x.ok).map((x) => x.department_id);
    for (const deptId of okIds) {
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `INSERT INTO offboarding_reminder_log (case_id, department_id, days_before) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [c.id, deptId, window.days_before]
      );
    }
    if (okIds.length) {
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        'UPDATE offboarding_clearance_sections SET last_reminded_at = now() WHERE case_id = $1 AND department_id = ANY($2::int[])',
        [c.id, okIds]
      );
    }
    sent += okIds.length;
    failed += r.results.length - okIds.length;
    // eslint-disable-next-line no-await-in-loop
    await lifecycle.logEvent(db, c.id, null, 'reminder_sent', {
      automatic: true, days_before: window.days_before, days_left: daysLeft, departments: okIds,
      failed: r.results.filter((x) => !x.ok).map((x) => x.department_id),
    });
  }

  // Follow-ups: Exit Interview / acknowledgement / payroll / onboarding
  // reminders and the Monday HR digest (lib/reminders.js).
  const followUps = await reminders.runFollowUps(today);

  return res.json({ today, cases: cases.length, sent, failed, skipped, follow_ups: followUps });
}));

module.exports = router;
