'use strict';
// HR feedback 15 Oct 2026:
//   • a status change to Rejected no longer emails the candidate;
//   • the dashboard keeps working when notification_log can't be read
//     (it was created by a different database login → "permission denied").
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');

const SUPER = `Bearer ${fx.adminToken({ email: 'boss@wct.my', unit_scope: 'ALL' })}`;
const api = (method, path, auth, body) => request()[method](`/api/admin${path}`).set('Authorization', auth).send(body);
const wait = () => new Promise((r) => setTimeout(r, 100));

let pa;
before(async () => {
  await resetDb();
  pa = await paStub.start(['POWER_AUTOMATE_URL_STATUS_CHANGE', 'POWER_AUTOMATE_URL_OFFBOARDING_EMAIL']);
  await fx.admin({ email: 'boss@wct.my', grants: [{ role: 'super_admin' }] });
  await db().query("UPDATE business_units SET pic_email = 'pic.land@wct.my' WHERE code = 'Land'");
});
beforeEach(() => pa.reset());
after(async () => { await pa.stop(); await db().pool.end(); });

const statusCalls = () => pa.calls.filter((c) => c.url.includes('POWER_AUTOMATE_URL_STATUS_CHANGE'));

async function submittedApp(email) {
  const a = await fx.hiredApplication({ email, business_unit: 'Land' });
  await db().query("UPDATE applications SET status = 'submitted' WHERE id = $1", [a.id]);
  return a;
}

describe('status-change emails', () => {
  test('Rejected: status saved, no email sent to the candidate', async () => {
    const a = await submittedApp('reject.me@gmail.com');
    const res = await api('post', `/applications/${a.id}/status`, SUPER, { status: 'rejected' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'rejected');
    await wait();
    assert.equal(statusCalls().length, 0, 'no status-change webhook for rejected');
  });

  test('Hired: still sends exactly one status-change email', async () => {
    const a = await submittedApp('hire.me@gmail.com');
    const res = await api('post', `/applications/${a.id}/status`, SUPER, { status: 'hired' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await wait();
    assert.equal(statusCalls().length, 1);
    assert.equal(statusCalls()[0].body.status, 'hired');
  });
});

describe('dashboard without a readable notification_log', () => {
  before(async () => { await db().query('ALTER TABLE notification_log RENAME TO notification_log_hidden'); });
  after(async () => { await db().query('ALTER TABLE notification_log_hidden RENAME TO notification_log'); });

  test('applications list still loads (last reminder date blank)', async () => {
    const res = await api('get', '/applications', SUPER);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.total >= 2);
    assert.ok(res.body.rows.every((r) => r.last_onboarding_reminder_at === null));
    assert.ok(res.body.rows.every((r) => typeof r.onboarding_status === 'string'));
  });
});

describe('dashboard with notification_log', () => {
  test('applications list includes the reminder columns', async () => {
    const res = await api('get', '/applications', SUPER);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok('last_onboarding_reminder_at' in res.body.rows[0]);
  });
});
