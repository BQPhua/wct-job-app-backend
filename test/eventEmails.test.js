'use strict';
// Every recruitment / admin email in one standard layout, built on the server
// (3 Nov 2026), with business unit names instead of codes.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const paStub = require('./helpers/paStub');
const ev = require('../src/lib/eventEmails');

let pa;
before(async () => {
  await resetDb();
  pa = await paStub.start(['POWER_AUTOMATE_URL_OFFBOARDING_EMAIL', 'POWER_AUTOMATE_URL_STATUS_CHANGE']);
});
beforeEach(() => pa.reset());
after(async () => { delete process.env.EVENT_EMAILS_VIA_FLOWS; await pa.stop(); await db().pool.end(); });

const app = { id: 'a1', reference_no: 'WCT-LAND-2026-000006', name_nric: 'Phua Bian Qi', position_applying: 'Data analyst', business_unit: 'Land', email: 'phua@gmail.com', status: 'hired' };
const layoutOk = (html) => {
  assert.match(html, /WCT Group of Companies/);
  assert.match(html, /wct-logo\.png/);
  assert.match(html, /please do not reply/i);
};

test('hired: candidate email in the standard layout with the unit name', async () => {
  const r = await ev.sendStatusChange(app, 'hr@wct.my');
  assert.equal(r.ok, true);
  const m = pa.calls[0].body;
  assert.equal(m.event_type, 'hired');
  assert.equal(m.to, 'phua@gmail.com');
  assert.match(m.html, /Property Development/);
  assert.doesNotMatch(m.html, />Land</);
  assert.match(m.html, /Complete your onboarding/);
  layoutOk(m.html);
});

test('other statuses are not emailed', async () => {
  const r = await ev.sendStatusChange({ ...app, status: 'shortlisted' }, 'hr@wct.my');
  assert.equal(r.skipped, 'not_emailed');
  assert.equal(pa.calls.length, 0);
});

test('onboarding completed goes to HR', async () => {
  await ev.sendOnboardingCompleted(app, { updated_at: new Date().toISOString() }, 'hr.land@wct.my;pic@wct.my');
  const m = pa.calls[0].body;
  assert.equal(m.event_type, 'onboarding_complete');
  assert.equal(m.to, 'hr.land@wct.my;pic@wct.my');
  assert.match(m.html, /Property Development/);
  assert.match(m.html, /admin\.html\?app=a1/);
  layoutOk(m.html);
});

test('admin invite and access changes', async () => {
  await ev.sendAdminInvite({ email: 'New.Admin@wct.my', name: 'New Admin', invitedBy: 'Boss' });
  await ev.sendPermissionChange({ eventType: 'grant_added', email: 'new.admin@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Mall' }], changedBy: 'Boss' });
  await ev.sendPermissionChange({ eventType: 'deactivated', email: 'new.admin@wct.my', grants: [{ role: 'super_admin' }], changedBy: 'Boss' });
  const [invite, added, off] = pa.calls.map((c) => c.body);
  assert.equal(invite.to, 'new.admin@wct.my');
  assert.match(invite.subject, /invited/i);
  assert.match(added.html, /HR Admin \(Malls Management\)/);
  assert.match(off.subject, /deactivated/);
  assert.doesNotMatch(off.html, /Open the Admin Dashboard/);
  [invite, added, off].forEach((m) => { layoutOk(m.html); assert.match(m.subject, /\[Do Not Reply\]$/); });
});

test('EVENT_EMAILS_VIA_FLOWS=on goes back to the old flows', async () => {
  process.env.EVENT_EMAILS_VIA_FLOWS = 'on';
  await ev.sendStatusChange(app, 'hr@wct.my');
  delete process.env.EVENT_EMAILS_VIA_FLOWS;
  assert.ok(pa.calls[0].url.includes('POWER_AUTOMATE_URL_STATUS_CHANGE'));
  assert.equal(pa.calls[0].body.business_unit, 'Property Development');
});
