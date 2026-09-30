'use strict';
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');
const lifecycle = require('../src/lib/offboarding/lifecycle');

const TODAY = '2026-10-01';
const HR = `Bearer ${fx.adminToken({ email: 'hr.land@wct.my', unit_scope: 'Land', roles: { bu_admin: true, payroll_pic: false, clearance_department_ids: [] } })}`;
let pa;
let n = 0;

async function invite(email) {
  n += 1;
  const res = await request().post('/api/admin/offboarding/cases').set('Authorization', HR).send({
    employee_email: email || `emp${n}@wct.my`, employee_name: `Employee ${n}`, business_unit: 'Land',
    position: 'Engineer', department: 'Construction', date_joined: '2021-01-04', immediate_superior_email: 'sup@wct.my',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { rows } = await db().query('SELECT * FROM offboarding_cases WHERE id = $1', [res.body.case.id]);
  return rows[0];
}
const emp = (method, url, token, body) => {
  const r = request()[method](`/api/offboarding${url}`).set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const GOOD = {
  notice_period_days: 30, official_last_day: '2026-11-15', actual_last_day: '2026-11-10',
  reasons: ['Better Offer', 'Health'], reasons_other: ['Moving closer to family'], comments: 'Thanks team',
  immediate_superior_name: 'Sue',
};
async function claimed(emailOverride) {
  const c = await invite(emailOverride);
  const who = await fx.candidate({ email: c.employee_email, provider: 'microsoft' });
  const res = await emp('post', '/claim', who.token, { token: c.invite_token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { c, who };
}

before(async () => {
  await resetDb();
  pa = await paStub.start();
  process.env.OFFBOARDING_TODAY_OVERRIDE = TODAY;
  await fx.admin({ email: 'hr.land@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  await fx.admin({ email: 'pay.land@wct.my', grants: [{ role: 'payroll_pic', business_unit: 'Land' }] });
});
beforeEach(() => pa.reset());
after(async () => { delete process.env.OFFBOARDING_TODAY_OVERRIDE; await pa.stop(); await db().pool.end(); });

describe('claim', () => {
  test('matching email (any case) binds the case to the signed-in user', async () => {
    const c = await invite('Mixed.Case@wct.my');
    const who = await fx.candidate({ email: 'mixed.case@wct.my' });
    const res = await emp('post', '/claim', who.token, { token: c.invite_token });
    assert.equal(res.status, 200);
    assert.equal(res.body.case_id, c.id);
    const { rows } = await db().query('SELECT employee_user_id FROM offboarding_cases WHERE id = $1', [c.id]);
    assert.equal(rows[0].employee_user_id, who.id);
    // Claiming again is harmless.
    assert.equal((await emp('post', '/claim', who.token, { token: c.invite_token })).status, 200);
  });

  test('different email → 403 naming the masked invited address (RF#1)', async () => {
    const c = await invite('priya.nair@wct.my');
    const other = await fx.candidate({ email: 'priya.personal@gmail.com', provider: 'google' });
    const res = await emp('post', '/claim', other.token, { token: c.invite_token });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /p\*+@wct\.my/);
    assert.ok(!res.body.error.includes('priya.nair'));
    assert.equal(res.body.invited_email_masked, 'p***@wct.my');
  });

  test('bad token 404; case already linked to a different account 403', async () => {
    const who = await fx.candidate({ email: `x${fx.uniq()}@wct.my` });
    assert.equal((await emp('post', '/claim', who.token, { token: 'nope' })).status, 404);
    const c = await invite();
    const first = await fx.candidate({ email: `first${fx.uniq()}@wct.my` });
    await db().query('UPDATE offboarding_cases SET employee_user_id = $2 WHERE id = $1', [c.id, first.id]);
    const owner = await fx.candidate({ email: c.employee_email });
    const res = await emp('post', '/claim', owner.token, { token: c.invite_token });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /another account/i);
  });
});

describe('employee flow', () => {
  test('mine lists only my bound cases; detail hides internal fields', async () => {
    const { c, who } = await claimed();
    const other = await fx.candidate({ email: `other${fx.uniq()}@wct.my` });
    const mine = await emp('get', '/mine', who.token);
    assert.deepEqual(mine.body.map((x) => x.id), [c.id]);
    assert.deepEqual((await emp('get', '/mine', other.token)).body, []);
    const d = await emp('get', `/mine/${c.id}`, who.token);
    assert.equal(d.status, 200);
    assert.equal(d.body.case.invite_token, undefined);
    assert.equal(d.body.reasons.length, 12);
    assert.equal((await emp('get', `/mine/${c.id}`, other.token)).status, 404);
  });

  test('draft save, then submit validation', async () => {
    const { c, who } = await claimed();
    const draft = await emp('patch', `/mine/${c.id}/exit-interview`, who.token, { comments: 'draft', reasons: ['Health', 'Not a reason'] });
    assert.equal(draft.status, 200);
    assert.deepEqual(draft.body.exitInterview.reasons, ['Health']);
    assert.equal(draft.body.exitInterview.comments, 'draft');

    const submit = (body) => emp('post', `/mine/${c.id}/exit-interview/submit`, who.token, body);
    let r = await submit({ ...GOOD, official_last_day: '2026-10-15', signature_name: 'Emp', declaration: true });
    assert.equal(r.status, 422);
    assert.equal(r.body.field, 'official_last_day');
    r = await submit({ ...GOOD, actual_last_day: '2026-09-01', signature_name: 'Emp', declaration: true });
    assert.equal(r.body.field, 'actual_last_day');
    r = await submit({ ...GOOD, reasons: [], reasons_other: [], signature_name: 'Emp', declaration: true });
    assert.equal(r.body.field, 'reasons');
    r = await submit({ ...GOOD, signature_name: '  ', declaration: true });
    assert.equal(r.body.field, 'signature_name');
    r = await submit({ ...GOOD, signature_name: 'Emp', declaration: false });
    assert.equal(r.body.field, 'declaration');
    r = await submit({ ...GOOD, notice_period_days: -1, signature_name: 'Emp', declaration: true });
    assert.equal(r.body.field, 'notice_period_days');
  });

  test('submit → clearance_in_progress, 6 sections, HR + department emails; locked afterwards', async () => {
    const { c, who } = await claimed();
    const r = await emp('post', `/mine/${c.id}/exit-interview/submit`, who.token, { ...GOOD, signature_name: 'Employee Sig', declaration: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.case.status, 'clearance_in_progress');
    assert.equal(r.body.sections.length, 6);
    assert.equal(r.body.exitInterview.employee_signature_name, 'Employee Sig');
    assert.equal(pa.byEvent('submitted_hr').length, 1);
    assert.equal(pa.byEvent('clearance_task').length, 6);
    const ru = pa.byEvent('clearance_task').find((x) => x.body.department === 'Reporting Unit');
    assert.equal(ru.body.to, 'sup@wct.my');
    assert.equal((await emp('patch', `/mine/${c.id}/exit-interview`, who.token, { comments: 'late' })).status, 409);
    assert.equal((await emp('post', `/mine/${c.id}/exit-interview/submit`, who.token, { ...GOOD, signature_name: 'x', declaration: true })).status, 409);
  });

  test('acknowledge only when pending_acknowledgement → pending_payroll + payroll email; PDFs', async () => {
    const { c, who } = await claimed();
    await emp('post', `/mine/${c.id}/exit-interview/submit`, who.token, { ...GOOD, signature_name: 'Emp', declaration: true });
    const early = await emp('post', `/mine/${c.id}/acknowledge`, who.token, { signature_name: 'Emp', declaration: true });
    assert.equal(early.status, 409);
    assert.equal((await emp('get', `/mine/${c.id}/pdf/exit-interview`, who.token)).status, 200);
    assert.equal((await emp('get', `/mine/${c.id}/pdf/clearance`, who.token)).status, 409);

    await db().query("UPDATE offboarding_clearance_sections SET status = 'complete', signed_by_name = 'X', signed_at = now() WHERE case_id = $1", [c.id]);
    await db().withTransaction((cl) => lifecycle.recalculate(cl, c.id));
    pa.reset();
    assert.equal((await emp('post', `/mine/${c.id}/acknowledge`, who.token, { signature_name: 'Emp' })).status, 422);
    const ok = await emp('post', `/mine/${c.id}/acknowledge`, who.token, { signature_name: 'Emp Ack', declaration: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.case.status, 'pending_payroll');
    assert.equal(ok.body.case.acknowledged_signature_name, 'Emp Ack');
    const pay = pa.byEvent('payroll_action');
    assert.equal(pay.length, 1);
    assert.equal(pay[0].body.to, 'pay.land@wct.my');
    assert.equal(pay[0].body.attachments.length, 2);
    const cl = await emp('get', `/mine/${c.id}/pdf/clearance`, who.token).buffer(true);
    assert.equal(cl.status, 200);
    assert.match(cl.headers['content-type'], /pdf/);
  });

  test('cancelled case is read-only for the employee', async () => {
    const { c, who } = await claimed();
    await request().post(`/api/admin/offboarding/cases/${c.id}/cancel`).set('Authorization', HR).send({ reason: 'Withdrawn' });
    const d = await emp('get', `/mine/${c.id}`, who.token);
    assert.equal(d.body.case.status, 'cancelled');
    assert.equal((await emp('patch', `/mine/${c.id}/exit-interview`, who.token, { comments: 'x' })).status, 409);
  });
});
