'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');
const lifecycle = require('../src/lib/offboarding/lifecycle');

let pa;
const run = (key = 'cron-test') => request().post('/api/offboarding/cron/reminders').set('x-cron-key', key);

async function caseWithLastDay(lastDay, { signed = [] } = {}) {
  return db().withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO offboarding_cases (ref_no, invite_token, employee_email, employee_name, business_unit, status,
         invited_by_email, actual_last_day)
       VALUES ($1, $2, $3, 'Leaver', 'Land', 'clearance_in_progress', 'hr@wct.my', $4) RETURNING *`,
      [await lifecycle.nextRefNo(client), fx.randomToken(), `c${fx.uniq()}@wct.my`, lastDay]
    );
    await lifecycle.createSections(client, rows[0]);
    if (signed.length) {
      await client.query(
        "UPDATE offboarding_clearance_sections SET status = 'complete' WHERE case_id = $1 AND department_id = ANY($2::int[])",
        [rows[0].id, signed]
      );
    }
    return rows[0];
  });
}
const logFor = async (id) => (await db().query(
  'SELECT department_id, days_before FROM offboarding_reminder_log WHERE case_id = $1 ORDER BY department_id', [id])).rows;

before(async () => {
  await resetDb();
  pa = await paStub.start();
  await fx.admin({ email: 'hr@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
});
beforeEach(async () => {
  pa.reset();
  await db().query("UPDATE offboarding_cases SET status = 'completed'"); // isolate each test's cases
});
after(async () => { delete process.env.OFFBOARDING_TODAY_OVERRIDE; await pa.stop(); await db().pool.end(); });

test('rejects a missing or wrong key', async () => {
  assert.equal((await request().post('/api/offboarding/cron/reminders')).status, 401);
  assert.equal((await run('wrong')).status, 401);
});

test('7 days out: one reminder per pending department, logged, and not repeated', async () => {
  process.env.OFFBOARDING_TODAY_OVERRIDE = '2026-10-01';
  const c = await caseWithLastDay('2026-10-08', { signed: [2] });
  const r = await run();
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, 5);
  assert.equal(pa.byEvent('reminder').length, 5);
  assert.ok(pa.byEvent('reminder').every((x) => x.body.subject.includes('7 day(s) left')));
  assert.deepEqual((await logFor(c.id)).map((l) => l.days_before), [7, 7, 7, 7, 7]);
  pa.reset();
  const again = await run();
  assert.equal(again.body.sent, 0);
  assert.equal(pa.calls.length, 0);
});

test('3 days out sends the 3-day reminder even after the 7-day one', async () => {
  process.env.OFFBOARDING_TODAY_OVERRIDE = '2026-10-01';
  const c = await caseWithLastDay('2026-10-06');
  await run(); // 5 days left → 7-day window
  process.env.OFFBOARDING_TODAY_OVERRIDE = '2026-10-04';
  pa.reset();
  const r = await run(); // 2 days left → 3-day window
  assert.equal(r.body.sent, 6);
  const log = await logFor(c.id);
  assert.equal(log.filter((l) => l.days_before === 3).length, 6);
  assert.equal(log.filter((l) => l.days_before === 7).length, 6);
});

test('a Power Automate failure is not logged, so the next run retries', async () => {
  process.env.OFFBOARDING_TODAY_OVERRIDE = '2026-10-01';
  const c = await caseWithLastDay('2026-10-03', { signed: [1, 2, 3, 4, 5] });
  pa.failNext(1);
  const r = await run();
  assert.equal(r.body.sent, 0);
  assert.equal(r.body.failed, 1);
  assert.equal((await logFor(c.id)).length, 0);
  const retry = await run();
  assert.equal(retry.body.sent, 1);
});

test('past last day and far-away last day are skipped without error (RF#4)', async () => {
  process.env.OFFBOARDING_TODAY_OVERRIDE = '2026-10-10';
  const past = await caseWithLastDay('2026-10-08');
  const far = await caseWithLastDay('2026-12-25');
  const r = await run();
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, 0);
  assert.equal((await logFor(past.id)).length, 0);
  assert.equal((await logFor(far.id)).length, 0);
});
