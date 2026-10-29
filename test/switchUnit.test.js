'use strict';
// Business-unit picker and "Switch business unit" (stakeholder feedback 2026-10-14).
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const oauthVerify = require('../src/lib/oauthVerify');

let verifyMock;
before(async () => {
  await resetDb();
  verifyMock = mock.method(oauthVerify, 'verifyMicrosoftIdToken', async (idToken) => ({
    email: String(idToken).toLowerCase(), subject: `oid-${idToken}`, name: idToken,
  }));
  await fx.admin({ email: 'multi@wct.my', name: 'Multi Unit', grants: [
    { role: 'bu_admin', business_unit: 'Land' }, { role: 'bu_admin', business_unit: 'Hotels' },
    { role: 'payroll_pic', business_unit: 'Land' }, { role: 'payroll_pic', business_unit: 'Mall' },
  ] });
  await fx.admin({ email: 'boss@wct.my', grants: [{ role: 'super_admin' }] });
  await fx.admin({ email: 'payall@wct.my', grants: [{ role: 'payroll_pic' }] });
});
after(async () => { verifyMock.mock.restore(); await db().pool.end(); });

const session = (idToken, body = {}) => request().post('/api/admin/auth/session').send({ id_token: idToken, ...body });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

test('/auth/microsoft lists the units with names and roles for the picker', async () => {
  const res = await request().post('/api/admin/auth/microsoft').send({ id_token: 'multi@wct.my' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.units.map((u) => [u.code, u.name, u.roles.bu_admin, u.roles.payroll_pic]), [
    ['Land', 'Property Development', true, true], ['Mall', 'Malls Management', false, true], ['Hotels', 'Hotels', true, false],
  ]);
  const boss = await request().post('/api/admin/auth/microsoft').send({ id_token: 'boss@wct.my' });
  assert.equal(boss.body.units[0].code, 'ALL');
  assert.equal(boss.body.units.length, 7, 'super admin: All + every active unit (REIT merged into Malls)');
});

test('a per-unit payroll session only carries payroll for that unit', async () => {
  const res = await session('multi@wct.my', { business_unit: 'Mall' });
  assert.equal(res.status, 200);
  const c = jwt.decode(res.body.token);
  assert.equal(c.unit_scope, 'Mall');
  assert.deepEqual(c.roles, { bu_admin: false, payroll_pic: true, clearance_department_ids: [] });
  const all = jwt.decode((await session('payall@wct.my')).body.token);
  assert.equal(all.unit_scope, 'GROUP');
  assert.equal(all.roles.payroll_all, true);
});

test('switching unit re-checks grants and returns a new session', async () => {
  const land = await session('multi@wct.my', { business_unit: 'Land' });
  const units = await request().get('/api/admin/auth/units').set(bearer(land.body.token));
  assert.equal(units.status, 200);
  assert.equal(units.body.current, 'Land');
  assert.deepEqual(units.body.units.map((u) => u.code), ['Land', 'Mall', 'Hotels']);

  const sw = await request().post('/api/admin/auth/switch').set(bearer(land.body.token)).send({ business_unit: 'Hotels' });
  assert.equal(sw.status, 200);
  const c = jwt.decode(sw.body.token);
  assert.equal(c.unit_scope, 'Hotels');
  assert.equal(c.email, 'multi@wct.my');
  assert.deepEqual(c.roles, { bu_admin: true, payroll_pic: false, clearance_department_ids: [] });

  const denied = await request().post('/api/admin/auth/switch').set(bearer(land.body.token)).send({ business_unit: 'E&C' });
  assert.equal(denied.status, 403);
});

test('super admin can switch between All and any unit', async () => {
  const boss = await session('boss@wct.my');
  assert.equal(jwt.decode(boss.body.token).unit_scope, 'ALL');
  const toHotels = await request().post('/api/admin/auth/switch').set(bearer(boss.body.token)).send({ business_unit: 'Hotels' });
  assert.equal(toHotels.status, 200);
  assert.equal(jwt.decode(toHotels.body.token).unit_scope, 'Hotels');
  const back = await request().post('/api/admin/auth/switch').set(bearer(toHotels.body.token)).send({ business_unit: 'ALL' });
  assert.equal(back.status, 200);
  assert.equal(jwt.decode(back.body.token).unit_scope, 'ALL');
});

test('a deactivated admin cannot switch with an old token', async () => {
  const land = await session('multi@wct.my', { business_unit: 'Land' });
  await db().query("UPDATE admin_users SET is_active = false WHERE email = 'multi@wct.my'");
  const sw = await request().post('/api/admin/auth/switch').set(bearer(land.body.token)).send({ business_unit: 'Hotels' });
  assert.equal(sw.status, 403);
  await db().query("UPDATE admin_users SET is_active = true WHERE email = 'multi@wct.my'");
});
