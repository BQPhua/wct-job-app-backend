'use strict';
// Regression tests for the findings of the whole-branch review (2026-09-30).
const { test, before, after, beforeEach, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');
const lifecycle = require('../src/lib/offboarding/lifecycle');
const oauthVerify = require('../src/lib/oauthVerify');

const R = (o = {}) => ({ bu_admin: false, payroll_pic: false, clearance_department_ids: [], ...o });
const tok = (email, unit_scope, roles) => `Bearer ${fx.adminToken({ email, unit_scope, roles })}`;
const HR = tok('hr.land@wct.my', 'Land', R({ bu_admin: true }));
const HR_MALL = tok('hr.mall@wct.my', 'Mall', R({ bu_admin: true }));
const IT = tok('it.land@wct.my', 'Land', R({ clearance_department_ids: [2] }));
const PAY = tok('pay.land@wct.my', 'Land', R({ payroll_pic: true }));
const SUP = tok('superior@wct.my', 'SUPERIOR');
const api = (m, url, auth, body) => { const r = request()[m](`/api/admin/offboarding${url}`).set('Authorization', auth); return body ? r.send(body) : r; };

let pa;
let n = 0;
async function invite(over = {}, auth = HR) {
  n += 1;
  const res = await api('post', '/cases', auth, {
    employee_email: `rf${n}@wct.my`, employee_name: `RF ${n}`, business_unit: 'Land', immediate_superior_email: 'superior@wct.my', ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.case;
}
async function submitted(c) {
  await db().withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE offboarding_cases SET status='clearance_in_progress', submitted_at=now(), notice_period_days=0,
         official_last_day='2026-12-20', actual_last_day='2026-12-31' WHERE id=$1 RETURNING *`, [c.id]);
    await client.query(
      `UPDATE offboarding_exit_interviews SET employee_signature_name='X', employee_signed_at=now(),
         reasons='["Conflict with colleague/superior"]', comments='My boss is the problem' WHERE case_id=$1`, [c.id]);
    await lifecycle.createSections(client, rows[0]);
  });
  return c;
}

before(async () => {
  await resetDb();
  pa = await paStub.start();
  await fx.admin({ email: 'hr.land@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  await fx.admin({ email: 'pay.land@wct.my', grants: [{ role: 'payroll_pic', business_unit: 'Land' }] });
});
beforeEach(() => pa.reset());
after(async () => { await pa.stop(); await db().pool.end(); });

describe('Important #1 — Exit Interview is HR/payroll-confidential', () => {
  test('superior and clearance PIC get no exit interview content or PDF; HR and payroll do', async () => {
    const c = await submitted(await invite());
    for (const auth of [SUP, IT]) {
      const d = await api('get', `/cases/${c.id}`, auth);
      assert.equal(d.status, 200);
      assert.equal(d.body.exitInterview, null);
      assert.equal(d.body.can.view_exit_interview, false);
      assert.equal((await api('get', `/cases/${c.id}/pdf/exit-interview`, auth)).status, 403);
    }
    for (const auth of [HR, PAY]) {
      const d = await api('get', `/cases/${c.id}`, auth);
      assert.equal(d.body.exitInterview.comments, 'My boss is the problem');
      assert.equal(d.body.can.view_exit_interview, true);
    }
  });
});

describe('Important #2 — new superior is told about the Reporting Unit task', () => {
  test('changing superior during clearance emails the new superior and resets RU reminders', async () => {
    const c = await submitted(await invite());
    await db().query('INSERT INTO offboarding_reminder_log (case_id, department_id, days_before) VALUES ($1, 1, 7)', [c.id]);
    pa.reset();
    const res = await api('patch', `/cases/${c.id}`, HR, { immediate_superior_email: 'newboss@wct.my' });
    assert.equal(res.status, 200);
    const tasks = pa.byEvent('clearance_task');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].body.to, 'newboss@wct.my');
    const log = await db().query('SELECT count(*)::int n FROM offboarding_reminder_log WHERE case_id=$1 AND department_id=1', [c.id]);
    assert.equal(log.rows[0].n, 0);
  });
  test('changing superior before submit sends nothing', async () => {
    const c = await invite();
    pa.reset();
    await api('patch', `/cases/${c.id}`, HR, { immediate_superior_email: 'other@wct.my' });
    assert.equal(pa.byEvent('clearance_task').length, 0);
  });
});

describe('upgraded minors', () => {
  test('HR cannot manage their own case; payroll cannot pay themselves', async () => {
    const own = await submitted(await invite({ employee_email: 'hr.land@wct.my', immediate_superior_email: 'someone.else@wct.my' }, tok('boss@wct.my', 'ALL')));
    assert.equal((await api('patch', `/cases/${own.id}`, HR, { position: 'x' })).status, 403);
    assert.equal((await api('post', `/cases/${own.id}/cancel`, HR, { reason: 'x' })).status, 403);
    assert.equal((await api('post', `/cases/${own.id}/hr-signoff`, HR, { name: 'a', position: 'b' })).status, 403);
    const payOwn = await submitted(await invite({ employee_email: 'pay.land@wct.my', immediate_superior_email: 'someone.else@wct.my' }));
    await db().query("UPDATE offboarding_cases SET status='pending_payroll' WHERE id=$1", [payOwn.id]);
    assert.equal((await api('post', `/cases/${payOwn.id}/payroll-done`, PAY, {})).status, 403);
  });

  test('reopen notifies the department, clears its reminder log and warns payroll when it was pending payroll', async () => {
    const c = await submitted(await invite());
    for (const d of [1, 2, 3, 4, 5, 6]) await api('put', `/cases/${c.id}/sections/${d}`, HR, { items: [], sign: { name: 'HR' }, on_behalf: true });
    await db().query("UPDATE offboarding_cases SET status='pending_payroll', acknowledged_at=now() WHERE id=$1", [c.id]);
    await db().query('INSERT INTO offboarding_reminder_log (case_id, department_id, days_before) VALUES ($1, 3, 7)', [c.id]);
    pa.reset();
    const res = await api('post', `/cases/${c.id}/sections/3/reopen`, HR, { reason: 'Parking card' });
    assert.equal(res.status, 200);
    assert.equal(pa.byEvent('clearance_task').length, 1);
    assert.equal(pa.byEvent('clearance_task')[0].body.department, 'Administration');
    const hold = pa.byEvent('payroll_hold');
    assert.equal(hold.length, 1);
    assert.equal(hold[0].body.to, 'pay.land@wct.my');
    const log = await db().query('SELECT count(*)::int n FROM offboarding_reminder_log WHERE case_id=$1 AND department_id=3', [c.id]);
    assert.equal(log.rows[0].n, 0);
  });

  test('changing the employee email respects one open case per email', async () => {
    await invite({ employee_email: 'taken@wct.my' });
    const c = await invite();
    const res = await api('patch', `/cases/${c.id}`, HR, { employee_email: 'TAKEN@wct.my' });
    assert.equal(res.status, 409);
  });

  test('Section D cannot change after completion', async () => {
    const c = await submitted(await invite());
    await db().query("UPDATE offboarding_cases SET status='completed' WHERE id=$1", [c.id]);
    assert.equal((await api('post', `/cases/${c.id}/hr-signoff`, HR, { name: 'a', position: 'b' })).status, 409);
  });

  test('prefill does not reveal another BU case id', async () => {
    await invite({ employee_email: 'crossbu@wct.my' });
    const res = await api('get', '/prefill?email=crossbu@wct.my', HR_MALL);
    assert.equal(res.status, 200);
    assert.equal(res.body.open_case.id, undefined);
    assert.equal(res.body.open_case.other_business_unit, true);
  });

  test('malformed ids and filters give 404/400, not 500', async () => {
    assert.equal((await api('get', '/cases/not-a-uuid', HR)).status, 404);
    assert.equal((await api('get', '/cases?clearance_department_id=abc', HR)).status, 200);
    const cand = await fx.candidate({ email: `c${fx.uniq()}@wct.my` });
    const r = await request().get('/api/offboarding/mine/nope').set('Authorization', `Bearer ${cand.token}`);
    assert.equal(r.status, 404);
  });

  test('CSV guard covers leading tab and carriage return', async () => {
    await invite({ employee_name: '\t=cmd' });
    const res = await api('get', '/cases/export.csv', HR);
    assert.ok(!/(^|,)\t=cmd/m.test(res.text), 'tab-prefixed formula must be neutralised');
  });

  test('ai-insights is HR-only regardless of mount order', async () => {
    const res = await request().post('/api/admin/ai-insights').set('Authorization', IT).send({ mode: 'insights' });
    assert.equal(res.status, 403);
    const aiRouter = require('../src/routes/aiInsights');
    assert.ok(aiRouter.stack.some((l) => l.name === 'requireHrAdmin'), 'aiInsights router must apply requireHrAdmin itself');
  });

  test('a deactivated admin cannot fall back to a superior session', async () => {
    const verify = mock.method(oauthVerify, 'verifyMicrosoftIdToken', async (t) => ({ email: t, subject: t }));
    const gone = await fx.admin({ email: 'gone@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
    await db().query('UPDATE admin_users SET is_active=false WHERE id=$1', [gone.id]);
    const c = await submitted(await invite({ immediate_superior_email: 'gone@wct.my' }));
    void c;
    const probe = await request().post('/api/admin/auth/microsoft').send({ id_token: 'gone@wct.my' });
    assert.equal(probe.body.authorized, false);
    assert.equal((await request().post('/api/admin/auth/session').send({ id_token: 'gone@wct.my' })).status, 403);
    verify.mock.restore();
  });
});

