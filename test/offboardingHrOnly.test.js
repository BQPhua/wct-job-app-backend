'use strict';
// Offboarding without department clearance and payroll (3 Nov 2026):
// HR invites -> employee submits the Exit Interview -> HR signs Section D
// -> completed, and the employee is emailed.
process.env.OFFBOARDING_CLEARANCE = 'off';
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, applyMigration, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');

const TODAY = '2026-11-03';
const R = (o = {}) => ({ bu_admin: false, payroll_pic: false, clearance_department_ids: [], ...o });
const HR = `Bearer ${fx.adminToken({ email: 'hr.land@wct.my', unit_scope: 'Land', roles: R({ bu_admin: true }) })}`;
const wait = () => new Promise((r) => setTimeout(r, 120));
let pa;

async function invite(email, extra = {}) {
  const res = await request().post('/api/admin/offboarding/cases').set('Authorization', HR).send({
    employee_email: email, employee_name: 'Aina Binti Ali', business_unit: 'Land',
    position: 'Engineer', department: 'Construction', date_joined: '2021-01-04', official_last_day: '2026-12-10', actual_last_day: '2026-12-10', ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { rows } = await db().query('SELECT * FROM offboarding_cases WHERE id = $1', [res.body.case.id]);
  return rows[0];
}
const emp = (method, url, token, body) => {
  const r = request()[method](`/api/offboarding${url}`).set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const admin = (method, url, body) => {
  const r = request()[method](`/api/admin/offboarding${url}`).set('Authorization', HR);
  return body ? r.send(body) : r;
};

before(async () => {
  await resetDb();
  await applyMigration('012'); // safe to run twice
  pa = await paStub.start();
  process.env.OFFBOARDING_TODAY_OVERRIDE = TODAY;
  await fx.admin({ email: 'hr.land@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
});
beforeEach(() => pa.reset());
after(async () => { delete process.env.OFFBOARDING_TODAY_OVERRIDE; delete process.env.OFFBOARDING_CLEARANCE; await pa.stop(); await db().pool.end(); });

describe('HR-only offboarding', () => {
  let c; let who;
  test('a new case is created in the HR-only flow', async () => {
    c = await invite('aina.leaving@wct.my');
    assert.equal(c.flow, 'hr_only');
    const meta = await admin('get', '/meta');
    assert.equal(meta.body.clearance_enabled, false);
    assert.ok(meta.body.statuses.some((s) => s.value === 'pending_hr_signoff'));
  });

  test('submitting the Exit Interview goes to HR, with no department checklists', async () => {
    who = await fx.candidate({ email: c.employee_email, provider: 'microsoft' });
    assert.equal((await emp('post', '/claim', who.token, { token: c.invite_token })).status, 200);
    pa.reset();
    const res = await emp('post', `/mine/${c.id}/exit-interview/submit`, who.token, {
            reasons: ['Better Offer'], comments: 'Thanks', signature_name: 'Aina Binti Ali', declaration: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.case.status, 'pending_hr_signoff');
    const sections = await db().query('SELECT count(*)::int AS n FROM offboarding_clearance_sections WHERE case_id = $1', [c.id]);
    assert.equal(sections.rows[0].n, 0);
    await wait();
    assert.deepEqual(pa.calls.map((x) => x.body.event_type), ['submitted_hr']);
    assert.equal(pa.calls[0].body.to, 'hr.land@wct.my');
    assert.match(pa.calls[0].body.html, /sign Section D/);
  });

  test('it is on HR\'s task list', async () => {
    const tasks = await admin('get', '/my-tasks');
    assert.equal(tasks.status, 200);
    assert.ok(tasks.body.signoffs.some((t) => t.id === c.id));
    const list = await admin('get', '/cases');
    assert.equal(list.body.counts.pending_hr_signoff, 1);
  });

  test('HR signing Section D completes the case and emails the employee', async () => {
    const res = await admin('post', `/cases/${c.id}/hr-signoff`, { name: 'Nur HR', position: 'HR Executive', comments: 'All the best' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.case.status, 'completed');
    assert.ok(res.body.case.completed_at);
    assert.equal(res.body.can.pdf_clearance, false);
    await wait();
    const mail = pa.byEvent('hr_signed');
    assert.equal(mail.length, 1);
    assert.equal(mail[0].body.to, 'aina.leaving@wct.my');
    assert.match(mail[0].body.subject, /signed by HR/);
    assert.match(mail[0].body.html, /Nur HR/);
    const list = await admin('get', '/cases');
    assert.equal(list.body.counts.completed_this_month, 1);
  });

  test('the employee sees it completed and signed', async () => {
    const res = await emp('get', `/mine/${c.id}`, who.token);
    assert.equal(res.body.case.status, 'completed');
    assert.equal(res.body.exitInterview.hr_signed_name, 'Nur HR');
  });

  test('HR is reminded 2 days after an unsigned submission', async () => {
    const d = await invite('reminded@wct.my');
    await db().query("UPDATE offboarding_cases SET status = 'pending_hr_signoff', submitted_at = now() - interval '2 days 1 hour' WHERE id = $1", [d.id]);
    const run = await request().post('/api/offboarding/cron/reminders').set('x-cron-key', 'cron-test');
    assert.equal(run.status, 200, JSON.stringify(run.body));
    await wait();
    const r = pa.byEvent('hr_signoff_reminder');
    assert.equal(r.length, 1);
    assert.equal(r[0].body.to, 'hr.land@wct.my');
  });

  test('the immediate superior is optional now, and required again with clearance on', async () => {
    process.env.OFFBOARDING_CLEARANCE = 'on';
    const full = await invite('full.flow@wct.my', { immediate_superior_email: 'sup@wct.my' });
    process.env.OFFBOARDING_CLEARANCE = 'off';
    assert.equal(full.flow, 'full');
  });
});
