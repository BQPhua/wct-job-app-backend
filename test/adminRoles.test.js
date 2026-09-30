'use strict';
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const oauthVerify = require('../src/lib/oauthVerify');

// Microsoft sign-in is stubbed: the "id_token" sent in each test IS the email.
let verifyMock;
before(async () => {
  await resetDb();
  verifyMock = mock.method(oauthVerify, 'verifyMicrosoftIdToken', async (idToken) => ({
    email: String(idToken).toLowerCase(), subject: `oid-${idToken}`, name: idToken,
  }));

  await fx.admin({ email: 'payroll.land@wct.my', grants: [{ role: 'payroll_pic', business_unit: 'Land' }] });
  await fx.admin({
    email: 'hr.land@wct.my',
    grants: [{ role: 'bu_admin', business_unit: 'Land' }, { role: 'clearance_pic', business_unit: 'Land', department_id: 2 }],
  });
  await fx.admin({ email: 'boss@wct.my', grants: [{ role: 'super_admin' }] });
  await fx.admin({ email: 'target@wct.my' });

  // An open case whose Reporting Unit section is assigned to a superior
  // who holds no admin grant at all.
  const c = await db().query(
    `INSERT INTO offboarding_cases (ref_no, invite_token, employee_email, employee_name, business_unit, status, invited_by_email)
     VALUES ('OFF-2026-9001', $1, 'leaver@wct.my', 'Leaver', 'Land', 'clearance_in_progress', 'hr.land@wct.my') RETURNING id`,
    [fx.randomToken()]
  );
  await db().query(
    "INSERT INTO offboarding_clearance_sections (case_id, department_id, assignee_email) VALUES ($1, 1, 'superior@wct.my')",
    [c.rows[0].id]
  );
});
after(async () => { verifyMock.mock.restore(); await db().pool.end(); });

const session = (idToken, body = {}) => request().post('/api/admin/auth/session').send({ id_token: idToken, ...body });

test('payroll-only admin gets a Land session carrying payroll role, blocked from job-app routes', async () => {
  const res = await session('payroll.land@wct.my', { business_unit: 'Land' });
  assert.equal(res.status, 200);
  const claims = jwt.decode(res.body.token);
  assert.equal(claims.unit_scope, 'Land');
  assert.deepEqual(claims.roles, { bu_admin: false, payroll_pic: true, clearance_department_ids: [] });

  const apps = await request().get('/api/admin/applications').set('Authorization', `Bearer ${res.body.token}`);
  assert.equal(apps.status, 403);
  const me = await request().get('/api/admin/me').set('Authorization', `Bearer ${res.body.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.roles.payroll_pic, true);
});

test('single-BU account needs no business_unit in the session request', async () => {
  const res = await session('payroll.land@wct.my');
  assert.equal(res.status, 200);
  assert.equal(jwt.decode(res.body.token).unit_scope, 'Land');
});

test('bu_admin + clearance_pic in the same BU are merged into one session', async () => {
  const res = await session('hr.land@wct.my', { business_unit: 'Land' });
  assert.equal(res.status, 200);
  assert.deepEqual(jwt.decode(res.body.token).roles, { bu_admin: true, payroll_pic: false, clearance_department_ids: [2] });
  const apps = await request().get('/api/admin/applications').set('Authorization', `Bearer ${res.body.token}`);
  assert.equal(apps.status, 200);
});

test('/auth/microsoft lists every BU a PIC role grants', async () => {
  const res = await request().post('/api/admin/auth/microsoft').send({ id_token: 'payroll.land@wct.my' });
  assert.equal(res.body.authorized, true);
  assert.deepEqual(res.body.bu_grants, ['Land']);
});

test('superior with no grants gets a SUPERIOR session', async () => {
  const probe = await request().post('/api/admin/auth/microsoft').send({ id_token: 'superior@wct.my' });
  assert.equal(probe.body.authorized, true);
  assert.equal(probe.body.superior, true);
  const res = await session('superior@wct.my');
  assert.equal(res.status, 200);
  const claims = jwt.decode(res.body.token);
  assert.equal(claims.unit_scope, 'SUPERIOR');
  assert.equal(claims.admin_user_id, null);
  assert.equal(claims.email, 'superior@wct.my');
  const apps = await request().get('/api/admin/applications').set('Authorization', `Bearer ${res.body.token}`);
  assert.equal(apps.status, 403);
});

test('unknown account is still refused', async () => {
  const probe = await request().post('/api/admin/auth/microsoft').send({ id_token: 'nobody@wct.my' });
  assert.equal(probe.body.authorized, false);
  const res = await session('nobody@wct.my');
  assert.equal(res.status, 403);
});

test('super admin session and legacy BU tokens keep full job-app access', async () => {
  const res = await session('boss@wct.my');
  assert.equal(jwt.decode(res.body.token).unit_scope, 'ALL');
  const ok = await request().get('/api/admin/applications').set('Authorization', `Bearer ${res.body.token}`);
  assert.equal(ok.status, 200);
  // Token minted before roles existed (no `roles` claim) = plain bu_admin.
  const legacy = fx.adminToken({ email: 'hr.land@wct.my', unit_scope: 'Land' });
  const ok2 = await request().get('/api/admin/applications').set('Authorization', `Bearer ${legacy}`);
  assert.equal(ok2.status, 200);
});

test('granting PIC roles validates department and labels the notification', async () => {
  const pa = await require('./helpers/paStub').start(['POWER_AUTOMATE_URL_ADMIN_ACTIVE']);
  const boss = await session('boss@wct.my');
  const auth = { Authorization: `Bearer ${boss.body.token}` };
  const target = await db().query("SELECT id FROM admin_users WHERE email = 'target@wct.my'");
  const url = `/api/admin/admins/${target.rows[0].id}/grants`;

  const noDept = await request().post(url).set(auth).send({ role: 'clearance_pic', business_unit: 'Land' });
  assert.equal(noDept.status, 400);
  const badDept = await request().post(url).set(auth).send({ role: 'clearance_pic', business_unit: 'Land', department_id: 99 });
  assert.equal(badDept.status, 400);
  const ok = await request().post(url).set(auth).send({ role: 'clearance_pic', business_unit: 'Land', department_id: 2 });
  assert.equal(ok.status, 201);
  const payroll = await request().post(url).set(auth).send({ role: 'payroll_pic', business_unit: 'Mall' });
  assert.equal(payroll.status, 201);
  const dup = await request().post(url).set(auth).send({ role: 'payroll_pic', business_unit: 'Mall' });
  assert.equal(dup.status, 409);

  await new Promise((r) => setTimeout(r, 50));
  const labels = pa.calls.map((c) => c.body.role_label);
  assert.ok(labels.includes('Clearance PIC — IT (Land)'), labels.join(' | '));
  assert.ok(labels.includes('Payroll PIC (Mall)'));

  const list = await request().get('/api/admin/admins').set(auth);
  const row = list.body.find((r) => r.email === 'target@wct.my' && r.role === 'clearance_pic');
  assert.equal(row.department_id, 2);
  assert.equal(row.department_name, 'IT');
  await pa.stop();
});
