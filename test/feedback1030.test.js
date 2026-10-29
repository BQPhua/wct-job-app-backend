'use strict';
// Stakeholder feedback, 30 Oct 2026: REIT merge undone (migration 010), form
// v3 family fields, a working forgot-password email, "Do Not Reply" subjects.
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, applyMigration, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');

let pa; let reitApp;
before(async () => {
  await resetDb({ stopBefore: '009' });
  reitApp = await fx.hiredApplication({ email: 'reit.again@wct.my', business_unit: 'REIT' });
  await db().query("UPDATE applications SET reference_no = 'WCT-REIT-2026-000009' WHERE id = $1", [reitApp.id]);
  await applyMigration('009');
  await applyMigration('010');
  pa = await paStub.start(['POWER_AUTOMATE_URL_OFFBOARDING_EMAIL']);
});
beforeEach(() => pa.reset());
after(async () => { await pa.stop(); await db().pool.end(); });
const wait = () => new Promise((r) => setTimeout(r, 100));

describe('migration 010 undoes the REIT merge', () => {
  test('REIT is active again and its applications are back', async () => {
    const bu = await db().query("SELECT is_active, merged_into FROM business_units WHERE code = 'REIT'");
    assert.deepEqual(bu.rows[0], { is_active: true, merged_into: null });
    const app = await db().query('SELECT business_unit FROM applications WHERE id = $1', [reitApp.id]);
    assert.equal(app.rows[0].business_unit, 'REIT');
    const pub = await request().get('/api/business-units');
    assert.ok(pub.body.some((u) => u.code === 'REIT'));
    assert.deepEqual(pub.body.find((u) => u.code === 'Mall').aliases, []);
  });
  test('safe to run again', async () => {
    await applyMigration('010');
    const bu = await db().query("SELECT is_active FROM business_units WHERE code = 'REIT'");
    assert.equal(bu.rows[0].is_active, true);
  });
});

describe('form v3 family fields', () => {
  let cand; let draft;
  before(async () => {
    cand = await fx.candidate({ email: 'family.v3@gmail.com' });
    draft = (await request().post('/api/applications').set('Authorization', `Bearer ${cand.token}`).send({ business_unit: 'Land' })).body;
  });
  const patch = (p) => request().patch(`/api/applications/${draft.id}`).set('Authorization', `Bearer ${cand.token}`).send({ reference_no: draft.reference_no, patch: p });
  test('spouse occupation and number of children are saved', async () => {
    const res = await patch({ spouse_name: 'Ali', spouse_occupation: 'Teacher', spouse_working: 'Yes', children_below_18_count: 2, children_18_to_23_count: 0 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.spouse_occupation, 'Teacher');
    assert.equal(res.body.children_below_18_count, 2);
    assert.equal(res.body.children_18_to_23_count, 0);
  });
  test('a number of children outside 0-20 is refused', async () => {
    assert.equal((await patch({ children_below_18_count: -1 })).status, 400);
    assert.equal((await patch({ children_18_to_23_count: 2.5 })).status, 400);
  });
});

describe('forgot password', () => {
  let user;
  before(async () => {
    await request().post('/api/auth/register').send({ email: 'forgot.me@gmail.com', password: 'Old#Pass1', full_name: 'Forgot Me' });
    user = 'forgot.me@gmail.com';
  });
  const linkToken = () => {
    const mail = pa.byEvent('password_reset')[0];
    return mail && /reset-password\.html\?token=([A-Za-z0-9_-]+)/.exec(mail.body.html)[1];
  };

  test('emails a reset link, marked Do Not Reply', async () => {
    const res = await request().post('/api/auth/reset-password/request').send({ email: user });
    assert.equal(res.status, 200);
    await wait();
    const mail = pa.byEvent('password_reset');
    assert.equal(mail.length, 1);
    assert.equal(mail[0].body.to, user);
    assert.match(mail[0].body.subject, /\[Do Not Reply\]$/);
    assert.ok(linkToken());
  });

  test('the link sets a new password once', async () => {
    await db().query('DELETE FROM password_reset_tokens');
    await request().post('/api/auth/reset-password/request').send({ email: user });
    const token = linkToken();
    const ok = await request().post('/api/auth/reset-password/confirm').send({ token, password: 'New#Pass2' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const again = await request().post('/api/auth/reset-password/confirm').send({ token, password: 'Other#Pass3' });
    assert.equal(again.status, 400);
    const login = await request().post('/api/auth/login').send({ email: user, password: 'New#Pass2' });
    assert.equal(login.status, 200);
  });

  test('unknown email: same answer, no email', async () => {
    const res = await request().post('/api/auth/reset-password/request').send({ email: 'nobody@gmail.com' });
    assert.equal(res.status, 200);
    await wait();
    assert.equal(pa.byEvent('password_reset').length, 0);
  });

  test('if the email cannot be sent, the candidate is told', async () => {
    await db().query('DELETE FROM password_reset_tokens');
    pa.failNext(1);
    const res = await request().post('/api/auth/reset-password/request').send({ email: user });
    assert.equal(res.status, 503);
  });

  test('a Google/Microsoft account gets a clear message, not a server error, on password login', async () => {
    await db().query("INSERT INTO users (email, full_name, auth_provider, auth_subject) VALUES ('oauth.only@gmail.com', 'O', 'google', 'g-1')");
    const res = await request().post('/api/auth/login').send({ email: 'oauth.only@gmail.com', password: 'Whatever#1' });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Google or Microsoft/);
  });
});
