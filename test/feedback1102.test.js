'use strict';
// Stakeholder feedback, 2 Nov 2026: spouse NRIC and date of birth are given
// at onboarding; the onboarding page knows the marital status.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');

let hired; let auth;
before(async () => {
  await resetDb();
  hired = await fx.hiredApplication({ email: 'spouse.ic@wct.my', business_unit: 'Land' });
  await db().query("UPDATE applications SET marital_status = 'Married', spouse_name = 'Lim Wei', spouse_occupation = 'Teacher' WHERE id = $1", [hired.id]);
  auth = `Bearer ${jwt.sign({ sub: hired.user_id, email: 'spouse.ic@wct.my' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
});
after(async () => { await db().pool.end(); });
const patch = (p) => request().patch(`/api/onboarding/${hired.id}`).set('Authorization', auth).send({ patch: p });

describe('onboarding spouse details', () => {
  test('the onboarding page gets the marital status and spouse from the application', async () => {
    const res = await request().get(`/api/onboarding/${hired.id}`).set('Authorization', auth);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.family.marital_status, 'Married');
    assert.equal(res.body.family.spouse_name, 'Lim Wei');
  });
  test('spouse NRIC and date of birth are saved on the onboarding record', async () => {
    const res = await patch({ spouse_nric: '900101101234', spouse_date_of_birth: '1990-01-01' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.spouse_nric, '900101101234');
    const row = await db().query("SELECT to_char(spouse_date_of_birth, 'YYYY-MM-DD') AS d FROM onboarding_records WHERE application_id = $1", [hired.id]);
    assert.equal(row.rows[0].d, '1990-01-01');
  });
  test('they can be cleared, and bad values are refused', async () => {
    assert.equal((await patch({ spouse_nric: '9001-01-10' })).status, 400);
    assert.equal((await patch({ spouse_date_of_birth: '01/01/1990' })).status, 400);
    const res = await patch({ spouse_nric: null, spouse_date_of_birth: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.spouse_nric, null);
  });
});
