'use strict';
// "No email notification received upon candidate application submission"
// (stakeholder feedback 29 Oct 2026): the submit route must always try to
// email HR, and a lookup problem must never fail the candidate's submission.
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');

const wait = () => new Promise((r) => setTimeout(r, 150));
let pa; let cand;
before(async () => {
  await resetDb();
  pa = await paStub.start(['POWER_AUTOMATE_URL_SUBMIT', 'POWER_AUTOMATE_URL_OFFBOARDING_EMAIL']);
  await fx.admin({ email: 'boss@wct.my', grants: [{ role: 'super_admin' }] });
  await fx.admin({ email: 'hr.land@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  cand = await fx.candidate({ email: 'applicant@gmail.com' });
});
beforeEach(() => pa.reset());
after(async () => { delete process.env.CANDIDATE_CONFIRMATION_EMAIL; await pa.stop(); await db().pool.end(); });

// HR's email is built on the server and sent through the generic email flow (3 Nov 2026).
const submitCalls = () => pa.byEvent('application_submitted_hr');
async function submit(bu, beforeSubmit) {
  const d = (await request().post('/api/applications').set('Authorization', `Bearer ${cand.token}`).send({ business_unit: bu })).body;
  await db().query("UPDATE applications SET pdpa_agreed = true, email = 'applicant@gmail.com', name_nric = 'Siti Aminah' WHERE id = $1", [d.id]);
  if (beforeSubmit) await beforeSubmit();
  const res = await request().post(`/api/applications/${d.id}/submit`).set('Authorization', `Bearer ${cand.token}`).send({ reference_no: d.reference_no });
  await wait();
  return { d, res };
}

describe('HR notification on submit', () => {
  test('goes to the unit HR admins plus its PIC email', async () => {
    await db().query("UPDATE business_units SET pic_email = 'pic.land@wct.my' WHERE code = 'Land'");
    const { res } = await submit('Land');
    assert.equal(res.status, 200);
    assert.equal(submitCalls().length, 1);
    assert.equal(submitCalls()[0].body.to, 'hr.land@wct.my;pic.land@wct.my');
    assert.match(submitCalls()[0].body.html, /Property Development/);
    assert.doesNotMatch(submitCalls()[0].body.html, />Land</);
    assert.match(submitCalls()[0].body.subject, /\[Do Not Reply\]$/);
  });

  test('a unit with no HR admin or PIC still emails the super admins', async () => {
    const { res } = await submit('Hotels');
    assert.equal(res.status, 200);
    assert.equal(submitCalls().length, 1);
    assert.equal(submitCalls()[0].body.to, 'boss@wct.my');
  });

  test('if the business unit list cannot be read, the submission still succeeds and HR is still emailed', async () => {
    try {
      const { res } = await submit('Land', () => db().query('ALTER TABLE business_units RENAME TO business_units_hidden'));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, 'submitted');
      assert.equal(submitCalls().length, 1);
      assert.equal(submitCalls()[0].body.to, 'hr.land@wct.my');
    } finally {
      await db().query('ALTER TABLE business_units_hidden RENAME TO business_units');
    }
  });

  test('candidate confirmation goes out with the HR email when switched on', async () => {
    process.env.CANDIDATE_CONFIRMATION_EMAIL = 'on';
    await submit('Land');
    delete process.env.CANDIDATE_CONFIRMATION_EMAIL;
    assert.equal(submitCalls().length, 1);
    const mail = pa.byEvent('application_received');
    assert.equal(mail.length, 1);
    assert.equal(mail[0].body.to, 'applicant@gmail.com');
  });
});
