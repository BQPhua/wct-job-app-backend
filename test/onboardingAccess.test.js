'use strict';
// Onboarding details access (migration 014, 6 Nov 2026): a Super Admin
// decides per admin whether they may see onboarding details.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, applyMigration, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');

const SUPER = `Bearer ${fx.adminToken({ email: 'boss@wct.my', unit_scope: 'ALL' })}`;
const R = { bu_admin: true, payroll_pic: false, clearance_department_ids: [] };
let yes; let no; let app;
let YES; let NO;
const api = (method, url, auth, body) => {
  const r = request()[method](`/api/admin${url}`).set('Authorization', auth);
  return body ? r.send(body) : r;
};

before(async () => {
  await resetDb();
  await applyMigration('014'); // safe to run twice
  yes = await fx.admin({ email: 'hr.yes@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  no = await fx.admin({ email: 'hr.no@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  YES = `Bearer ${fx.adminToken({ adminUserId: yes.id, email: yes.email, unit_scope: 'Land', roles: R })}`;
  NO = `Bearer ${fx.adminToken({ adminUserId: no.id, email: no.email, unit_scope: 'Land', roles: R })}`;
  app = await fx.hiredApplication({ email: `new.hire${fx.uniq()}@gmail.com` });
  await db().query(
    "INSERT INTO onboarding_records (application_id, status, epf_no, bank_account_no) VALUES ($1, 'completed', 'EPF123', '1234567890')",
    [app.id]
  );
});
after(async () => { await db().pool.end(); });

describe('onboarding details access', () => {
  test('existing admins keep access when the migration runs; new admins start without it', async () => {
    const { rows } = await db().query("SELECT can_view_onboarding FROM admin_users WHERE email = 'hr.no@wct.my'");
    assert.equal(rows[0].can_view_onboarding, false);
    // The migration turns it on for everyone who existed before it.
    await db().query('ALTER TABLE admin_users DROP COLUMN can_view_onboarding');
    await applyMigration('014');
    const after = await db().query('SELECT bool_and(can_view_onboarding) AS all_on FROM admin_users');
    assert.equal(after.rows[0].all_on, true);
    await db().query("UPDATE admin_users SET can_view_onboarding = false WHERE email = 'hr.no@wct.my'");
  });

  test('only a Super Admin can change it', async () => {
    const res = await api('patch', `/admins/${yes.id}/onboarding-access`, NO, { can_view_onboarding: false });
    assert.equal(res.status, 403);
    assert.equal((await api('patch', `/admins/${yes.id}/onboarding-access`, SUPER, {})).status, 400);
    assert.equal((await api('patch', '/admins/not-a-uuid/onboarding-access', SUPER, { can_view_onboarding: true })).status, 404);
    const ok = await api('patch', `/admins/${yes.id}/onboarding-access`, SUPER, { can_view_onboarding: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.can_view_onboarding, true);
    const list = await api('get', '/admins', SUPER);
    assert.equal(list.body.find((r) => r.email === 'hr.no@wct.my').can_view_onboarding, false);
    assert.equal(list.body.find((r) => r.email === 'hr.yes@wct.my').can_view_onboarding, true);
  });

  test('an admin without access sees the application but not the onboarding details', async () => {
    assert.equal((await api('get', `/applications/${app.id}`, NO)).status, 200);
    const ob = await api('get', `/applications/${app.id}/onboarding`, NO);
    assert.equal(ob.status, 403);
    assert.equal(ob.body.code, 'no_onboarding_access');
    assert.equal((await api('get', '/me', NO)).body.can_view_onboarding, false);
    const exp = await api('get', '/export', NO);
    const row = exp.body.find((r) => r.id === app.id);
    assert.equal(row.ob_status, 'completed');
    assert.equal(row.ob_epf_no, undefined);
    assert.equal(row.ob_bank_account_no, undefined);
  });

  test('an admin with access and a Super Admin see everything', async () => {
    for (const auth of [YES, SUPER]) {
      const ob = await api('get', `/applications/${app.id}/onboarding`, auth);
      assert.equal(ob.status, 200);
      assert.equal(ob.body.epf_no, 'EPF123');
      assert.equal((await api('get', '/me', auth)).body.can_view_onboarding, true);
      const row = (await api('get', '/export', auth)).body.find((r) => r.id === app.id);
      assert.equal(row.ob_bank_account_no, '1234567890');
    }
  });

  test('turning access off works at once, without signing in again', async () => {
    await api('patch', `/admins/${yes.id}/onboarding-access`, SUPER, { can_view_onboarding: false });
    assert.equal((await api('get', `/applications/${app.id}/onboarding`, YES)).status, 403);
    await api('patch', `/admins/${yes.id}/onboarding-access`, SUPER, { can_view_onboarding: true });
  });

  test('a Super Admin can give access when inviting', async () => {
    const res = await api('post', '/admins', SUPER, { email: `invited${fx.uniq()}@wct.my`, can_view_onboarding: true });
    assert.equal(res.status, 201);
    assert.equal(res.body.can_view_onboarding, true);
    const plain = await api('post', '/admins', SUPER, { email: `plain${fx.uniq()}@wct.my` });
    assert.equal(plain.body.can_view_onboarding, false);
  });
});
