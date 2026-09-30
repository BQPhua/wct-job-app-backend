'use strict';
// Review finding (Important #3): legacy free-text notice periods.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, applyMigration, db } = require('./helpers/db');
const fx = require('./helpers/fixtures');

const cases = [['30 days', 30], ['30', 30], ['1 month', 30], ['2 months', 60], ['2 weeks', 14], ['ask HR', null], ['99999999999', null]];

before(async () => {
  await resetDb({ stopBefore: '005' });
  for (const [text] of cases) {
    const a = await fx.hiredApplication({ email: `np${fx.uniq()}@wct.my` });
    await db().query("UPDATE applications SET status='offboarding' WHERE id=$1", [a.id]);
    await db().query('INSERT INTO exit_interviews (application_id, notice_period) VALUES ($1, $2)', [a.id, text]);
  }
  await applyMigration('005');
});
after(async () => { await db().pool.end(); });

test('free-text notice periods convert sensibly or become NULL, original text kept', async () => {
  const { rows } = await db().query(
    `SELECT l.notice_period AS legacy, c.notice_period_days AS days, e.detail->>'legacy_notice_period' AS kept
       FROM offboarding_cases c JOIN legacy_exit_interviews l ON l.application_id = c.application_id
       JOIN offboarding_events e ON e.case_id = c.id AND e.event_type = 'invited'`);
  for (const [text, expected] of cases) {
    const r = rows.find((x) => x.legacy === text);
    assert.equal(r.days, expected, `"${text}" -> ${r.days}, expected ${expected}`);
    assert.equal(r.kept, text);
  }
});
