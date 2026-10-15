'use strict';
// Application form v2, manual onboarding reminders and the candidate
// confirmation email (stakeholder feedback 2026-10-14).
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');

const R = (o = {}) => ({ bu_admin: false, payroll_pic: false, clearance_department_ids: [], ...o });
const HR_LAND = `Bearer ${fx.adminToken({ email: 'hr.land@wct.my', unit_scope: 'Land', roles: R({ bu_admin: true }) })}`;
const HR_MALL = `Bearer ${fx.adminToken({ email: 'hr.mall@wct.my', unit_scope: 'Mall', roles: R({ bu_admin: true }) })}`;
const wait = () => new Promise((r) => setTimeout(r, 80));

let pa;
before(async () => {
  await resetDb();
  pa = await paStub.start(['POWER_AUTOMATE_URL_OFFBOARDING_EMAIL', 'POWER_AUTOMATE_URL_SUBMIT']);
  await fx.admin({ email: 'hr.land@wct.my', name: 'Nur HR', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
});
beforeEach(() => pa.reset());
after(async () => { delete process.env.CANDIDATE_CONFIRMATION_EMAIL; await pa.stop(); await db().pool.end(); });

describe('candidate form v2 fields', () => {
  let cand; let draft;
  before(async () => {
    cand = await fx.candidate({ email: 'v2@gmail.com' });
    draft = (await request().post('/api/applications').set('Authorization', `Bearer ${cand.token}`).send({ business_unit: 'Land' })).body;
  });
  const patch = (p) => request().patch(`/api/applications/${draft.id}`).set('Authorization', `Bearer ${cand.token}`)
    .send({ reference_no: draft.reference_no, patch: p });

  test('address lines, city/state, family and no-experience are saved', async () => {
    const res = await patch({
      permanent_address: 'No. 12, Jalan Damai 3/2', permanent_address2: 'Taman Damai Indah', permanent_postcode: '47100',
      permanent_city: 'Puchong', permanent_state: 'Selangor', correspondence_address2: 'Blok B',
      correspondence_city: 'Shah Alam', correspondence_state: 'Selangor', no_working_experience: true,
      spouse_name: 'Ali', spouse_nric: '900101101234', spouse_date_of_birth: '1990-01-01', spouse_working: 'Yes',
      children_below_18: [{ name: 'Adam', gender: 'Male', nric: '150101101234', date_of_birth: '2015-01-01', course_name: 'Primary School', tax_relief: true }],
      children_18_to_23: [],
      referee1: { name: 'John', designation: 'Manager', company: 'ABC Sdn Bhd', relationship: 'Supervisor', contact: '0123456789' },
      attachments: [{ name: 'ic.jpg', url: '/api/files/attachments/u/ic.jpg?exp=2107340964&sig=abc', type: 'image/jpeg', category: 'ic_front' }, { name: 'cv.pdf', url: '/api/files/attachments/u/cv.pdf?exp=2107340964&sig=abc', type: 'application/pdf', category: 'resume' }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.permanent_address2, 'Taman Damai Indah');
    assert.equal(res.body.permanent_state, 'Selangor');
    assert.equal(res.body.no_working_experience, true);
    assert.equal(res.body.spouse_date_of_birth, '1990-01-01');
    assert.equal(res.body.children_below_18[0].name, 'Adam');
    assert.equal(res.body.referee1.company, 'ABC Sdn Bhd');
    assert.equal(res.body.attachments[0].category, 'ic_front');
  });
  test('no-experience can be switched back off', async () => {
    const res = await patch({ no_working_experience: false });
    assert.equal(res.body.no_working_experience, false);
  });
});

describe('candidate confirmation email', () => {
  test('is sent from the server (formal layout) only when switched on', async () => {
    const cand = await fx.candidate({ email: 'confirm@gmail.com' });
    const submitOne = async () => {
      const d = (await request().post('/api/applications').set('Authorization', `Bearer ${cand.token}`).send({ business_unit: 'Land' })).body;
      await db().query("UPDATE applications SET pdpa_agreed = true, email = 'confirm@gmail.com', name_nric = 'Nurul Aina', position_applying = 'Engineer' WHERE id = $1", [d.id]);
      const res = await request().post(`/api/applications/${d.id}/submit`).set('Authorization', `Bearer ${cand.token}`).send({ reference_no: d.reference_no });
      assert.equal(res.status, 200);
      await wait();
      return d;
    };
    await submitOne();
    assert.equal(pa.byEvent('application_received').length, 0, 'off by default');

    process.env.CANDIDATE_CONFIRMATION_EMAIL = 'on';
    const d = await submitOne();
    const mail = pa.byEvent('application_received');
    assert.equal(mail.length, 1);
    assert.equal(mail[0].body.to, 'confirm@gmail.com');
    assert.match(mail[0].body.subject, new RegExp(d.reference_no));
    assert.match(mail[0].body.html, /Thank you for completing your profile with WCT Group!/);
    assert.match(mail[0].body.html, /Property Development/);
    assert.match(mail[0].body.html, /wct-logo\.png/, 'formal logo');
    assert.match(mail[0].body.html, /This is an automated email.*please do not reply/i);
    delete process.env.CANDIDATE_CONFIRMATION_EMAIL;
  });
});

describe('manual onboarding reminder', () => {
  let hired;
  before(async () => {
    hired = await fx.hiredApplication({ email: 'newhire@wct.my', business_unit: 'Land', name: 'New Hire', position: 'QS' });
  });

  test('HR sends one; it is limited to once per candidate per day', async () => {
    const res = await request().post(`/api/admin/applications/${hired.id}/onboarding-reminder`).set('Authorization', HR_LAND);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.last_onboarding_reminder_at);
    assert.equal(res.body.onboarding_status, 'not_started');
    await wait();
    const mail = pa.byEvent('onboarding_reminder');
    assert.equal(mail.length, 1);
    assert.equal(mail[0].body.to, 'newhire@wct.my');
    assert.match(mail[0].body.html, /Complete my onboarding/);

    const again = await request().post(`/api/admin/applications/${hired.id}/onboarding-reminder`).set('Authorization', HR_LAND);
    assert.equal(again.status, 429);
  });

  test('the dashboard list shows onboarding status and the last reminder', async () => {
    const list = await request().get('/api/admin/applications?page_size=50').set('Authorization', HR_LAND);
    const row = list.body.rows.find((r) => r.id === hired.id);
    assert.equal(row.onboarding_status, 'not_started');
    assert.ok(row.last_onboarding_reminder_at);
  });

  test('refused for other units, non-hired and completed onboarding', async () => {
    assert.equal((await request().post(`/api/admin/applications/${hired.id}/onboarding-reminder`).set('Authorization', HR_MALL)).status, 403);
    const sub = await fx.hiredApplication({ email: 'notyet@wct.my', business_unit: 'Land' });
    await db().query("UPDATE applications SET status = 'shortlisted' WHERE id = $1", [sub.id]);
    assert.equal((await request().post(`/api/admin/applications/${sub.id}/onboarding-reminder`).set('Authorization', HR_LAND)).status, 409);
    const done = await fx.hiredApplication({ email: 'done@wct.my', business_unit: 'Land' });
    await db().query("INSERT INTO onboarding_records (application_id, status) VALUES ($1, 'completed')", [done.id]);
    assert.equal((await request().post(`/api/admin/applications/${done.id}/onboarding-reminder`).set('Authorization', HR_LAND)).status, 409);
  });

  test('bulk: sends to each eligible selected candidate and reports the rest', async () => {
    const a = await fx.hiredApplication({ email: 'bulk1@wct.my', business_unit: 'Land' });
    const b = await fx.hiredApplication({ email: 'bulk2@wct.my', business_unit: 'Land' });
    const res = await request().post('/api/admin/onboarding-reminders').set('Authorization', HR_LAND)
      .send({ application_ids: [a.id, b.id, hired.id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.sent, 2);
    assert.equal(res.body.skipped.length, 1);
  });

  test('the automatic reminder does not repeat on the day a manual one went out', async () => {
    const { runFollowUps } = require('../src/lib/reminders');
    const c = await fx.hiredApplication({ email: 'auto@wct.my', business_unit: 'Land' });
    await request().post(`/api/admin/applications/${c.id}/onboarding-reminder`).set('Authorization', HR_LAND);
    pa.reset();
    await runFollowUps();
    assert.ok(!pa.byEvent('onboarding_reminder').some((m) => m.body.to === 'auto@wct.my'));
  });
});

describe('onboarding', () => {
  let cand; let app;
  before(async () => {
    cand = await fx.candidate({ email: 'ob@gmail.com' });
    app = await fx.hiredApplication({ email: 'ob@gmail.com', business_unit: 'Land', userId: cand.id });
    await db().query("UPDATE applications SET spouse_name = 'Siti', children_below_18 = '[{\"name\":\"Aiman\"}]' WHERE id = $1", [app.id]);
  });
  const auth = () => ({ Authorization: `Bearer ${cand.token}` });

  test('GET returns the unit companies for salary crediting and the family details from the application', async () => {
    const res = await request().get(`/api/onboarding/${app.id}`).set(auth());
    assert.equal(res.status, 200);
    assert.ok(res.body.available_companies.includes('WCT Properties Sdn Bhd'));
    assert.ok(!res.body.available_companies.includes('WCT Berhad'), 'only this unit');
    assert.equal(res.body.family.spouse_name, 'Siti');
    assert.equal(res.body.family.children_below_18[0].name, 'Aiman');
  });

  test('confirming a section records the typed signature name', async () => {
    const res = await request().post(`/api/onboarding/${app.id}/confirm-section`).set(auth())
      .send({ section: 'personal_details', signed_name: 'Ob Person' });
    assert.equal(res.status, 200);
    assert.equal(res.body.personal_details_signed_name, 'Ob Person');
    const s = await request().patch(`/api/onboarding/${app.id}`).set(auth()).send({ patch: { salary_company: 'WCT Properties Sdn Bhd' } });
    assert.equal(s.body.salary_company, 'WCT Properties Sdn Bhd');
  });
});

describe('also applied elsewhere', () => {
  test("lists the candidate's other submitted applications, never their drafts", async () => {
    const a = await fx.hiredApplication({ email: 'twice@wct.my', business_unit: 'Land', name: 'Twice' });
    const other = await fx.hiredApplication({ email: 'twice@wct.my', business_unit: 'Hotels', name: 'Twice' });
    const draft = await fx.hiredApplication({ email: 'twice@wct.my', business_unit: 'REIT', name: 'Twice' });
    await db().query("UPDATE applications SET status = 'draft' WHERE id = $1", [draft.id]);
    const res = await request().get(`/api/admin/applications/${a.id}/other-bu`).set('Authorization', HR_LAND);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((r) => r.reference_no), [other.reference_no]);
  });
});

describe('patch shape checks (admin-side XSS defence)', () => {
  let cand; let draft;
  before(async () => {
    cand = await fx.candidate({ email: 'xss@gmail.com' });
    draft = (await request().post('/api/applications').set('Authorization', `Bearer ${cand.token}`).send({ business_unit: 'Land' })).body;
  });
  const patch = (p) => request().patch(`/api/applications/${draft.id}`).set('Authorization', `Bearer ${cand.token}`)
    .send({ reference_no: draft.reference_no, patch: p });
  test('crafted file links, categories and ratings are refused; real ones pass', async () => {
    assert.equal((await patch({ profile_picture_url: 'x" onerror="alert(1)' })).status, 400);
    assert.equal((await patch({ attachments: [{ name: 'a', url: 'javascript:alert(1)' }] })).status, 400);
    assert.equal((await patch({ attachments: [{ name: 'a', url: '/api/files/attachments/u/f.pdf?exp=1&sig=abc', category: 'evil' }] })).status, 400);
    assert.equal((await patch({ language_ability: [{ language: 'English', spoken: '"><img>', written: 'Good' }] })).status, 400);
    const ok = await patch({ profile_picture_url: '/api/files/profile-pictures/u/p.png?exp=2107340964&sig=a19R_n-V', attachments: [{ name: 'cv.pdf', type: 'application/pdf', url: '/api/files/attachments/u/cv.pdf?exp=2107340964&sig=abc', category: 'resume' }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await patch({ profile_picture_url: null })).status, 200, 'removing the photo is allowed');
  });
});
