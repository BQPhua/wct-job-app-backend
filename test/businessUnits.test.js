'use strict';
// Business units as a managed list (migration 008, stakeholder feedback 2026-10-14).
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');

const R = (o = {}) => ({ bu_admin: false, payroll_pic: false, clearance_department_ids: [], ...o });
const SUPER = `Bearer ${fx.adminToken({ email: 'boss@wct.my', unit_scope: 'ALL' })}`;
const HR_LAND = `Bearer ${fx.adminToken({ email: 'hr.land@wct.my', unit_scope: 'Land', roles: R({ bu_admin: true }) })}`;

let pa;
before(async () => {
  await resetDb();
  pa = await paStub.start(['POWER_AUTOMATE_URL_SUBMIT', 'POWER_AUTOMATE_URL_OFFBOARDING_EMAIL']);
  await fx.admin({ email: 'boss@wct.my', grants: [{ role: 'super_admin' }] });
  await fx.admin({ email: 'hr.land@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
});
beforeEach(() => pa.reset());
after(async () => { await pa.stop(); await db().pool.end(); });

describe('public list', () => {
  test('GET /api/business-units lists active units with display names, no sign-in needed', async () => {
    const res = await request().get('/api/business-units');
    assert.equal(res.status, 200);
    const byCode = Object.fromEntries(res.body.map((u) => [u.code, u.name]));
    assert.equal(byCode.Land, 'Property Development');
    assert.equal(byCode.Mall, 'Malls Management');
    assert.deepEqual(Object.keys(byCode), ['E&C', 'Land', 'Mall', 'REIT', 'Aviation', 'F&B', 'Hotels']);
    assert.equal(res.body[0].pic_email, undefined, 'PIC emails are not public');
  });
});

describe('candidate drafts', () => {
  let cand;
  before(async () => { cand = await fx.candidate({ email: 'cand@gmail.com' }); });
  const draft = (bu) => request().post('/api/applications').set('Authorization', `Bearer ${cand.token}`).send({ business_unit: bu });
  const year = new Date().getUTCFullYear();

  test('new units get their own reference prefix', async () => {
    for (const [bu, prefix] of [['REIT', 'REIT'], ['Aviation', 'AV'], ['F&B', 'FNB'], ['Hotels', 'HTL'], ['Land', 'LAND']]) {
      const res = await draft(bu);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.reference_no, `WCT-${prefix}-${year}-000001`);
    }
  });
  test('a link may use the display name; it is stored as the code', async () => {
    const res = await draft('property development');
    assert.equal(res.status, 201);
    const row = await db().query('SELECT business_unit FROM applications WHERE id = $1', [res.body.id]);
    assert.equal(row.rows[0].business_unit, 'Land');
  });
  test('unknown and inactive units are refused', async () => {
    assert.equal((await draft('Bogus')).status, 400);
    await db().query("UPDATE business_units SET is_active = false WHERE code = 'REIT'");
    assert.equal((await draft('REIT')).status, 400);
    await db().query("UPDATE business_units SET is_active = true WHERE code = 'REIT'");
  });
  test('submitting notifies the unit HR admins and its PIC email', async () => {
    await db().query("UPDATE business_units SET pic_email = 'pic.land@wct.my' WHERE code = 'Land'");
    const d = await draft('Land');
    await db().query('UPDATE applications SET pdpa_agreed = true WHERE id = $1', [d.body.id]);
    const res = await request().post(`/api/applications/${d.body.id}/submit`).set('Authorization', `Bearer ${cand.token}`)
      .send({ reference_no: d.body.reference_no });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 100));
    const submit = pa.calls.find((c) => c.url.includes('POWER_AUTOMATE_URL_SUBMIT'));
    assert.ok(submit, 'submit webhook fired');
    assert.deepEqual(submit.body.notify_email.split(';').sort(), ['hr.land@wct.my', 'pic.land@wct.my']);
    assert.equal(submit.body.business_unit_name, 'Property Development');
  });
});

describe('Business Unit Settings (super admin)', () => {
  const api = (m, url, auth, body) => { const r = request()[m](`/api/admin${url}`).set('Authorization', auth); return body ? r.send(body) : r; };

  test('HR admins can read the list; only super admins change it', async () => {
    const list = await api('get', '/business-units', HR_LAND);
    assert.equal(list.status, 200);
    assert.ok(list.body.find((u) => u.code === 'Land').pic_email !== undefined);
    assert.equal((await api('post', '/business-units', HR_LAND, { code: 'LOG', name: 'Logistics', ref_code: 'LOG' })).status, 403);
  });
  test('add, rename, deactivate and delete an unused unit', async () => {
    const add = await api('post', '/business-units', SUPER, { code: 'Logistics', name: 'Logistics', ref_code: 'log', pic_email: 'hr.log@wct.my' });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.equal(add.body.ref_code, 'LOG');
    assert.equal((await api('post', '/business-units', SUPER, { code: 'Logi2', name: 'logistics', ref_code: 'LG' })).status, 409, 'duplicate name');
    assert.equal((await api('post', '/business-units', SUPER, { code: 'bad code!', name: 'X', ref_code: 'X1' })).status, 400);
    const upd = await api('patch', '/business-units/Logistics', SUPER, { name: 'Logistics & Supply', is_active: false });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.name, 'Logistics & Supply');
    assert.equal(upd.body.is_active, false);
    const pub = await request().get('/api/business-units');
    assert.ok(!pub.body.find((u) => u.code === 'Logistics'), 'inactive unit hidden from candidates');
    assert.equal((await api('delete', '/business-units/Logistics', SUPER)).status, 204);
  });
  test('a unit with applications or companies cannot be deleted', async () => {
    const res = await api('delete', '/business-units/Land', SUPER);
    assert.equal(res.status, 409);
  });
  test('companies can be created in the new units and are listed with their unit', async () => {
    const res = await api('post', '/companies', SUPER, { name: 'New Hotel Sdn Bhd', business_unit: 'Hotels' });
    assert.equal(res.status, 201);
    const list = await api('get', '/companies/manage', SUPER);
    assert.equal(list.body.find((c) => c.name === 'New Hotel Sdn Bhd').business_unit, 'Hotels');
    assert.equal((await api('post', '/companies', HR_LAND, { name: 'X', business_unit: 'Hotels' })).status, 403);
    const id = list.body.find((c) => c.name === 'New Hotel Sdn Bhd').id;
    const moved = await api('patch', `/companies/${id}`, SUPER, { business_unit: 'REIT' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.business_unit, 'REIT');
    assert.equal((await api('patch', `/companies/${id}`, SUPER, { business_unit: 'Nope' })).status, 400);
  });
  test('super admin can move an application to a new unit', async () => {
    const a = await fx.hiredApplication({ email: 'mover@wct.my', business_unit: 'Land' });
    const res = await api('patch', `/applications/${a.id}`, SUPER, { business_unit: 'Hotels' });
    assert.equal(res.status, 200);
    assert.equal(res.body.business_unit, 'Hotels');
    assert.equal((await api('patch', `/applications/${a.id}`, SUPER, { business_unit: 'Nope' })).status, 400);
  });
});
