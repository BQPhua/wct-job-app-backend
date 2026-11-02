'use strict';
// Stakeholder feedback, 3 Nov 2026: citizenship for the spouse and each child
// at onboarding — NRIC (12 digits) for Malaysians, passport otherwise.
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
