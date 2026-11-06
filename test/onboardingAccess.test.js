'use strict';
// Onboarding details access (migrations 014 + 015, 6 Nov 2026): a Super Admin
// decides per business unit, on each HR Admin grant, whether the person may
// see onboarding details there.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, applyMigration, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');

const SUPER = `Bearer ${fx.adminToken({ email: 'boss@wct.my', unit_scope: 'ALL' })}`;
const R = { bu_admin: true, payroll_pic: false, clearance_department_ids: [] };
let hr; let other; let landApp; let mallApp;
let HR_LAND; let HR_MALL; let OTHER_LAND;
const api = (method, url, auth, body) => {
  const r = request()[method](`/api/admin${url}`).set('Authorization', auth);
  return body ? r.send(body) : r;
};
const grantOf = async (adminId, unit) => (await db().query(
  "SELECT id, can_view_onboarding FROM admin_grants WHERE admin_user_id = $1 AND role = 'bu_admin' AND business_unit = $2", [adminId, unit]
)).rows[0];

before(async () => {
  await resetDb();
  await applyMigration('015'); // safe to run twice
  // One person, HR Admin in two units.
  hr = await fx.admin({ email: 'hr.two@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }, { role: 'bu_admin', business_unit: 'Mall' }] });
  other = await fx.admin({ email: 'hr.other@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  HR_LAND = `Bearer ${fx.adminToken({ adminUserId: hr.id, email: hr.email, unit_scope: 'Land', roles: R })}`;
  HR_MALL = `Bearer ${fx.adminToken({ adminUserId: hr.id, email: hr.email, unit_scope: 'Mall', roles: R })}`;
  OTHER_LAND = `Bearer ${fx.adminToken({ adminUserId: other.id, email: other.email, unit_scope: 'Land', roles: R })}`;
  landApp = await fx.hiredApplication({ email: `land${fx.uniq()}@gmail.com`, business_unit: 'Land' });
  mallApp = await fx.hiredApplication({ email: `mall${fx.uniq()}@gmail.com`, business_unit: 'Mall' });
  for (const a of [landApp, mallApp]) {
    await db().query(
      "INSERT INTO onboarding_records (application_id, status, epf_no, bank_account_no) VALUES ($1, 'completed', 'EPF123', '1234567890')",
      [a.id]
    );
  }
});
after(async () => { await db().pool.end(); });

describe('onboarding details access per business unit', () => {
  test('migration 015 copies the per-person setting from 014 onto HR Admin grants', async () => {
    await db().query('ALTER TABLE admin_grants DROP COLUMN can_view_onboarding');
    await db().query("UPDATE admin_users SET can_view_onboarding = (email = 'hr.two@wct.my')");
    await applyMigration('015');
    assert.equal((await grantOf(hr.id, 'Land')).can_view_onboarding, true);
    assert.equal((await grantOf(hr.id, 'Mall')).can_view_onboarding, true);
    assert.equal((await grantOf(other.id, 'Land')).can_view_onboarding, false);
  });

  test('a Super Admin turns it off for one unit only', async () => {
    const mall = await grantOf(hr.id, 'Mall');
    assert.equal((await api('patch', `/grants/${mall.id}/onboarding-access`, HR_LAND, { can_view_onboarding: false })).status, 403);
    assert.equal((await api('patch', `/grants/${mall.id}/onboarding-access`, SUPER, {})).status, 400);
    assert.equal((await api('patch', '/grants/nope/onboarding-access', SUPER, { can_view_onboarding: true })).status, 404);
    const res = await api('patch', `/grants/${mall.id}/onboarding-access`, SUPER, { can_view_onboarding: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.can_view_onboarding, false);
    const list = (await api('get', '/admins', SUPER)).body.filter((r) => r.email === 'hr.two@wct.my');
    assert.deepEqual(list.map((r) => [r.business_unit, r.can_view_onboarding]).sort(), [['Land', true], ['Mall', false]]);
  });

  test('the same person sees onboarding in Land but not in Mall', async () => {
    const ok = await api('get', `/applications/${landApp.id}/onboarding`, HR_LAND);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.epf_no, 'EPF123');
    assert.equal((await api('get', '/me', HR_LAND)).body.can_view_onboarding, true);
    assert.equal((await api('get', '/export', HR_LAND)).body.find((r) => r.id === landApp.id).ob_bank_account_no, '1234567890');

    assert.equal((await api('get', `/applications/${mallApp.id}`, HR_MALL)).status, 200);
    const no = await api('get', `/applications/${mallApp.id}/onboarding`, HR_MALL);
    assert.equal(no.status, 403);
    assert.equal(no.body.code, 'no_onboarding_access');
    assert.equal((await api('get', '/me', HR_MALL)).body.can_view_onboarding, false);
    const row = (await api('get', '/export', HR_MALL)).body.find((r) => r.id === mallApp.id);
    assert.equal(row.ob_status, 'completed');
    assert.equal(row.ob_epf_no, undefined);
  });

  test('a Super Admin always sees onboarding', async () => {
    for (const a of [landApp, mallApp]) {
      assert.equal((await api('get', `/applications/${a.id}/onboarding`, SUPER)).status, 200);
    }
  });

  test('turning it on takes effect at once, without signing in again', async () => {
    assert.equal((await api('get', `/applications/${landApp.id}/onboarding`, OTHER_LAND)).status, 403);
    const g = await grantOf(other.id, 'Land');
    await api('patch', `/grants/${g.id}/onboarding-access`, SUPER, { can_view_onboarding: true });
    assert.equal((await api('get', `/applications/${landApp.id}/onboarding`, OTHER_LAND)).status, 200);
  });

  test('new HR Admin access starts without onboarding unless ticked; only HR Admin grants carry it', async () => {
    const person = await fx.admin({ email: `new${fx.uniq()}@wct.my` });
    const plain = await api('post', `/admins/${person.id}/grants`, SUPER, { role: 'bu_admin', business_unit: 'Land' });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.can_view_onboarding, false);
    const ticked = await api('post', `/admins/${person.id}/grants`, SUPER, { role: 'bu_admin', business_unit: 'Mall', can_view_onboarding: true });
    assert.equal(ticked.body.can_view_onboarding, true);
    const sup = await api('post', `/admins/${person.id}/grants`, SUPER, { role: 'super_admin' });
    assert.equal((await api('patch', `/grants/${sup.body.id}/onboarding-access`, SUPER, { can_view_onboarding: true })).status, 400);
  });
});
