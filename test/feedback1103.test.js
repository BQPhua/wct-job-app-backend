'use strict';
// Stakeholder feedback, 3 Nov 2026: citizenship for the spouse and each child
// at onboarding — NRIC (12 digits) for Malaysians, passport otherwise; a
// business unit's HR admin may transfer an application to another unit.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { resetDb, applyMigration, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');

let hired; let auth;
before(async () => {
  await resetDb();
  await applyMigration('011'); // safe to run twice
  hired = await fx.hiredApplication({ email: 'citizen.ob@wct.my', business_unit: 'Land' });
  auth = `Bearer ${jwt.sign({ sub: hired.user_id, email: 'citizen.ob@wct.my' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
});
after(async () => { await db().pool.end(); });
const patch = (p) => request().patch(`/api/onboarding/${hired.id}`).set('Authorization', auth).send({ patch: p });

describe('onboarding citizenship', () => {
  test('a non-Malaysian spouse is saved with a passport number', async () => {
    const res = await patch({ spouse_citizen: 'Non-Malaysian', spouse_passport_no: 'K12345678', spouse_date_of_birth: '1989-05-04' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.spouse_citizen, 'Non-Malaysian');
    assert.equal(res.body.spouse_passport_no, 'K12345678');
  });
  test('a Malaysian spouse NRIC must be 12 digits', async () => {
    assert.equal((await patch({ spouse_citizen: 'Malaysian', spouse_nric: '90010110123' })).status, 400);
    assert.equal((await patch({ spouse_citizen: 'Malaysian', spouse_nric: '900101101234' })).status, 200);
    assert.equal((await patch({ spouse_citizen: 'Singaporean' })).status, 400);
  });
  test('children carry citizen and NRIC or passport', async () => {
    const ok = await patch({ children_below_18: [
      { name: 'Ali', citizen: 'Malaysian', nric: '150301101234' },
      { name: 'Mei', citizen: 'Non-Malaysian', passport_no: 'E7654321' },
    ] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.children_below_18[1].passport_no, 'E7654321');
    const bad = await patch({ children_below_18: [{ name: 'Ali', citizen: 'Malaysian', nric: '1503011012' }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Ali: NRIC must be exactly 12 digits/);
  });
});

describe('transfer by a business unit HR admin', () => {
  const R = (o = {}) => ({ bu_admin: false, payroll_pic: false, clearance_department_ids: [], ...o });
  const HR_LAND = `Bearer ${fx.adminToken({ email: 'hr.land@wct.my', unit_scope: 'Land', roles: R({ bu_admin: true }) })}`;
  const HR_MALL = `Bearer ${fx.adminToken({ email: 'hr.mall@wct.my', unit_scope: 'Mall', roles: R({ bu_admin: true }) })}`;
  let app;
  before(async () => {
    app = await fx.hiredApplication({ email: 'move.me@wct.my', business_unit: 'Land' });
    await db().query("UPDATE applications SET status = 'submitted' WHERE id = $1", [app.id]);
  });
  const move = (auth, bu, id = app.id) => request().patch(`/api/admin/applications/${id}`).set('Authorization', auth).send({ business_unit: bu });

  test('another unit cannot move it', async () => {
    assert.equal((await move(HR_MALL, 'Mall')).status, 403);
  });
  test('its own unit HR admin moves it to Malls', async () => {
    const res = await move(HR_LAND, 'Mall');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.business_unit, 'Mall');
  });
  test('after the move it belongs to Malls only', async () => {
    assert.equal((await request().get(`/api/admin/applications/${app.id}`).set('Authorization', HR_LAND)).status, 403);
    assert.equal((await request().get(`/api/admin/applications/${app.id}`).set('Authorization', HR_MALL)).status, 200);
  });
  test('an unknown unit is refused', async () => {
    assert.equal((await move(HR_MALL, 'Nope')).status, 400);
  });
  test('saving other details with the same unit still works', async () => {
    const res = await request().patch(`/api/admin/applications/${app.id}`).set('Authorization', HR_MALL).send({ business_unit: 'Mall', mobile_phone: '012-3456789' });
    assert.equal(res.status, 200);
  });
});
