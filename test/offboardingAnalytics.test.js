'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');
const lifecycle = require('../src/lib/offboarding/lifecycle');

const R = (o = {}) => ({ bu_admin: false, payroll_pic: false, clearance_department_ids: [], ...o });
const tok = (email, unit_scope, roles) => `Bearer ${fx.adminToken({ email, unit_scope, roles })}`;
const HR_LAND = tok('hr.land@wct.my', 'Land', R({ bu_admin: true }));
const HR_MALL = tok('hr.mall@wct.my', 'Mall', R({ bu_admin: true }));
const PAY_LAND = tok('pay.land@wct.my', 'Land', R({ payroll_pic: true }));
const IT_LAND = tok('it.land@wct.my', 'Land', R({ clearance_department_ids: [2] }));
const SUPER = tok('boss@wct.my', 'ALL');
const TODAY = '2026-10-01';

let pa;
let n = 0;
const api = (url, auth) => request().get(`/api/admin/offboarding${url}`).set('Authorization', auth);

async function makeCase({ bu = 'Land', hr = bu === 'Land' ? HR_LAND : HR_MALL, joined = '2022-03-01', lastDay = '2026-09-15',
  reasons = ['Health'], other = [], dept = 'Construction', submitDaysAfterInvite = 2 } = {}) {
  n += 1;
  const res = await request().post('/api/admin/offboarding/cases').set('Authorization', hr).send({
    employee_email: `an${n}@wct.my`, employee_name: `An ${n}`, business_unit: bu, department: dept, position: 'Engineer',
    date_joined: joined, immediate_superior_email: 'superior@wct.my', official_last_day: lastDay,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.case.id;
  await db().withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE offboarding_cases SET invited_at = '2026-08-01T02:00:00Z',
         submitted_at = '2026-08-01T02:00:00Z'::timestamptz + make_interval(days => $2::int),
         status = 'clearance_in_progress', notice_period_days = 30, actual_last_day = official_last_day
       WHERE id = $1 RETURNING *`, [id, submitDaysAfterInvite]);
    await client.query('UPDATE offboarding_exit_interviews SET reasons = $2::jsonb, reasons_other = $3 WHERE case_id = $1',
      [id, JSON.stringify(reasons), other]);
    await lifecycle.createSections(client, rows[0]);
  });
  return id;
}
/** Sign department `d` `days` days after the case was submitted. */
async function sign(id, d, days, onBehalf = false) {
  await db().query(
    `UPDATE offboarding_clearance_sections s SET status = 'complete', signed_by_name = 'X', signed_on_behalf = $4,
       signed_at = c.submitted_at + make_interval(days => $3::int)
       FROM offboarding_cases c WHERE c.id = s.case_id AND s.case_id = $1 AND s.department_id = $2`, [id, d, days, onBehalf]);
}

before(async () => {
  await resetDb();
  pa = await paStub.start();
  process.env.OFFBOARDING_TODAY_OVERRIDE = TODAY;
  await fx.admin({ email: 'hr.land@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  await fx.admin({ email: 'hr.mall@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Mall' }] });

  // Land A: completed. Every department signs on day 4 (Finance on day 10).
  const a = await makeCase({ reasons: ['Health', 'Better Offer'], joined: '2016-01-01', lastDay: '2026-09-15' });
  for (const d of [1, 2, 3, 5, 6]) await sign(a, d, 4);
  await sign(a, 4, 10, true);
  await db().query(
    `UPDATE offboarding_cases SET status = 'completed', acknowledged_at = submitted_at + interval '11 days',
       payroll_completed_at = submitted_at + interval '13 days' WHERE id = $1`, [a]);
  // Land B: overdue, still in clearance; IT signed day 2, the rest pending.
  const b = await makeCase({ reasons: ['Better Offer'], other: ['Family'], joined: '2026-03-01', lastDay: '2026-09-20', submitDaysAfterInvite: 4 });
  await sign(b, 2, 2);
  // Land C: cancelled — excluded from leavers, counted in status.
  const c = await makeCase({ lastDay: '2026-11-30' });
  await db().query("UPDATE offboarding_cases SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'withdrawn' WHERE id = $1", [c]);
  // Mall D: open, must never show in Land analytics.
  await makeCase({ bu: 'Mall', reasons: ['Relocation'], lastDay: '2026-12-15' });
});
beforeEach(() => pa.reset());
after(async () => { delete process.env.OFFBOARDING_TODAY_OVERRIDE; await pa.stop(); await db().pool.end(); });

test('HR only: Payroll and Clearance PICs are refused', async () => {
  assert.equal((await api('/analytics', PAY_LAND)).status, 403);
  assert.equal((await api('/analytics', IT_LAND)).status, 403);
});

test('Land HR sees only Land: status, leavers, overdue', async () => {
  const r = await api('/analytics?months=all', HR_LAND);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body;
  assert.equal(a.scope, 'Land');
  assert.equal(a.totals.cases, 3);
  assert.equal(a.totals.completed, 1);
  assert.equal(a.totals.cancelled, 1);
  assert.equal(a.totals.open, 1);
  assert.equal(a.totals.overdue, 1);
  assert.equal(a.by_status.find((s) => s.status === 'cancelled').count, 1);
  assert.equal(a.by_bu, undefined, 'BU breakdown is for super admins only');
  // Leavers by month of last day, cancelled excluded: both in Sep 2026.
  assert.deepEqual(a.leavers_by_month.find((m) => m.month === '2026-09'), { month: '2026-09', count: 2 });
});

test('exit reasons, own-words reasons and tenure buckets', async () => {
  const a = (await api('/analytics?months=all', HR_LAND)).body;
  const reason = (r) => (a.exit_reasons.find((x) => x.reason === r) || {}).count;
  assert.equal(reason('Better Offer'), 2);
  assert.equal(reason('Health'), 1); // the cancelled case's reason is not counted
  assert.equal(reason('Other (own words)'), 1);
  assert.equal(a.exit_reasons[0].reason, 'Better Offer', 'sorted most common first');
  const bucket = (k) => a.tenure.find((t) => t.bucket === k).count;
  assert.equal(bucket('Under 1 year'), 1);
  assert.equal(bucket('10+ years'), 1);
});

test('timings and department turnaround', async () => {
  const a = (await api('/analytics?months=all', HR_LAND)).body;
  assert.equal(a.timings.invite_to_submit_days, 3); // (2 + 4) / 2
  assert.equal(a.timings.clearance_days, 10); // only A finished clearance: last signature day 10
  assert.equal(a.timings.ack_to_payroll_days, 2);
  assert.equal(a.timings.invite_to_complete_days, 15);
  assert.equal(a.timings.clearance_on_time_pct, 100); // A cleared on 2026-08-13, before its 15 Sep last day
  const dept = (name) => a.departments.find((d) => d.department === name);
  assert.equal(dept('Finance').avg_days, 10);
  assert.equal(dept('Finance').on_behalf, 1);
  assert.equal(dept('IT').avg_days, 3); // (4 + 2) / 2
  assert.equal(dept('IT').pending, 0);
  assert.equal(dept('Finance').pending, 1);
  assert.equal(a.departments.length, 6);
  assert.deepEqual(a.top_departments[0], { name: 'Construction', count: 2 });
});

test('super admin sees every BU with a BU breakdown, and can filter one BU', async () => {
  const all = (await api('/analytics?months=all', SUPER)).body;
  assert.equal(all.totals.cases, 4);
  assert.deepEqual(all.by_bu.map((b) => [b.business_unit, b.count]), [['E&C', 0], ['Land', 3], ['Mall', 1]]);
  const mall = (await api('/analytics?months=all&business_unit=Mall', SUPER)).body;
  assert.equal(mall.totals.cases, 1);
  assert.equal(mall.scope, 'Mall');
  // A BU admin can't widen their own scope with the filter.
  const sneaky = (await api('/analytics?months=all&business_unit=Mall', HR_LAND)).body;
  assert.equal(sneaky.totals.cases, 3);
});

test('period filter keeps cases invited in the last N months', async () => {
  await db().query("UPDATE offboarding_cases SET invited_at = '2024-01-10T00:00:00Z' WHERE employee_email = 'an3@wct.my'");
  const recent = (await api('/analytics?months=12', HR_LAND)).body;
  assert.equal(recent.totals.cases, 2);
  assert.equal((await api('/analytics?months=abc', HR_LAND)).status, 400);
});
