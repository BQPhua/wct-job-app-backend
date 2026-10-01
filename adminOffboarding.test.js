'use strict';
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');
const lifecycle = require('../src/lib/offboarding/lifecycle');

const R = (o = {}) => ({ bu_admin: false, payroll_pic: false, clearance_department_ids: [], ...o });
const tok = (email, unit_scope, roles) => `Bearer ${fx.adminToken({ email, unit_scope, roles })}`;

const HR_LAND = tok('hr.land@wct.my', 'Land', R({ bu_admin: true }));
const HR_LAND_AS_MALL = tok('hr.land@wct.my', 'Mall', R({ bu_admin: true })); // same person, other BU session
const HR_MALL = tok('hr.mall@wct.my', 'Mall', R({ bu_admin: true }));
const IT_LAND = tok('it.land@wct.my', 'Land', R({ clearance_department_ids: [2] }));
const PAY_LAND = tok('pay.land@wct.my', 'Land', R({ payroll_pic: true }));
const PAY_MALL = tok('pay.mall@wct.my', 'Mall', R({ payroll_pic: true }));
const SUPER = tok('boss@wct.my', 'ALL');
const SUPERIOR = tok('superior@wct.my', 'SUPERIOR');
// A superior who is ALSO the Land IT PIC (Review Focus #3).
const IT_AND_SUPERIOR = tok('it.land@wct.my', 'Land', R({ clearance_department_ids: [2] }));

let pa;
const api = (method, url, auth, body) => {
  const r = request()[method](`/api/admin/offboarding${url}`).set('Authorization', auth);
  return body ? r.send(body) : r;
};

let n = 0;
async function invite(auth = HR_LAND, over = {}) {
  n += 1;
  const res = await api('post', '/cases', auth, {
    employee_email: `leaver${n}@wct.my`, employee_name: `Leaver ${n}`, business_unit: 'Land',
    company_name: 'WCT Land Sdn Bhd', department: 'Construction', position: 'Engineer', date_joined: '2022-03-01',
    immediate_superior_name: 'Sue', immediate_superior_email: 'superior@wct.my', official_last_day: '2026-12-31', ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.case;
}

/** Simulate the employee submitting their Exit Interview (Task 7 does this via API). */
async function submitted(caseRow) {
  await db().withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE offboarding_cases SET status = 'clearance_in_progress', submitted_at = now(), notice_period_days = 30,
         actual_last_day = '2026-12-31' WHERE id = $1 RETURNING *`, [caseRow.id]);
    await client.query(
      "UPDATE offboarding_exit_interviews SET employee_signature_name = 'Leaver', employee_signed_at = now(), reasons = '[\"Health\"]' WHERE case_id = $1",
      [caseRow.id]);
    await lifecycle.createSections(client, rows[0]);
  });
  return (await lifecycle.loadBundle(db(), caseRow.id));
}

async function signAll(caseId, auth = HR_LAND) {
  for (const d of [1, 2, 3, 4, 5, 6]) {
    const res = await api('put', `/cases/${caseId}/sections/${d}`, auth, { items: [], sign: { name: 'HR Person' }, on_behalf: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
}

before(async () => {
  await resetDb();
  pa = await paStub.start();
  await fx.admin({ email: 'hr.land@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }, { role: 'bu_admin', business_unit: 'Mall' }] });
  await fx.admin({ email: 'it.land@wct.my', grants: [{ role: 'clearance_pic', business_unit: 'Land', department_id: 2 }] });
  await fx.admin({ email: 'pay.land@wct.my', grants: [{ role: 'payroll_pic', business_unit: 'Land' }] });
  await fx.admin({ email: 'boss@wct.my', grants: [{ role: 'super_admin' }] });
});
beforeEach(() => pa.reset());
after(async () => { await pa.stop(); await db().pool.end(); });

describe('meta and prefill', () => {
  test('meta returns departments, reasons, roles', async () => {
    const res = await api('get', '/meta', IT_LAND);
    assert.equal(res.status, 200);
    assert.equal(res.body.departments.length, 6);
    assert.equal(res.body.reasons.length, 12);
    assert.deepEqual(res.body.roles.clearance_department_ids, [2]);
    assert.deepEqual(res.body.business_units, ['Land']);
    const s = await api('get', '/meta', SUPER);
    assert.deepEqual(s.body.business_units, ['E&C', 'Land', 'Mall']);
  });

  test('prefill finds the hired application in scope', async () => {
    await fx.hiredApplication({ email: 'Hired.Guy@wct.my', business_unit: 'Land', name: 'Hired Guy', position: 'QS' });
    const res = await api('get', '/prefill?email=hired.guy@wct.my', HR_LAND);
    assert.equal(res.status, 200);
    assert.equal(res.body.employee_name, 'Hired Guy');
    assert.equal(res.body.position, 'QS');
    assert.equal(res.body.business_unit, 'Land');
    assert.ok(res.body.application_id);
    const other = await api('get', '/prefill?email=hired.guy@wct.my', HR_MALL);
    assert.equal(other.body.application_id, undefined);
    assert.equal((await api('get', '/prefill?email=x@wct.my', IT_LAND)).status, 403);
  });
});

describe('invite', () => {
  test('HR invites → 201, invited, invite email sent to employee, application linked', async () => {
    await fx.hiredApplication({ email: 'linked@wct.my', business_unit: 'Land' });
    const c = await invite(HR_LAND, { employee_email: 'Linked@WCT.my' });
    assert.equal(c.status, 'invited');
    assert.equal(c.employee_email, 'linked@wct.my');
    assert.match(c.ref_no, /^OFF-\d{4}-\d{4}$/);
    assert.ok(c.application_id);
    const inv = pa.byEvent('invite');
    assert.equal(inv.length, 1);
    assert.equal(inv[0].body.to, 'linked@wct.my');
  });

  test('BU admin cannot invite into another BU; PICs cannot invite', async () => {
    const res = await api('post', '/cases', HR_LAND, { employee_email: 'a@wct.my', employee_name: 'A', business_unit: 'Mall' });
    assert.equal(res.status, 403);
    const pic = await api('post', '/cases', IT_LAND, { employee_email: 'a@wct.my', employee_name: 'A', business_unit: 'Land' });
    assert.equal(pic.status, 403);
  });

  test('validation and duplicate open case', async () => {
    const bad = await api('post', '/cases', HR_LAND, { employee_email: 'nope', employee_name: '', business_unit: 'Land' });
    assert.equal(bad.status, 400);
    const same = await api('post', '/cases', HR_LAND, { employee_email: 's@wct.my', employee_name: 'S', business_unit: 'Land', immediate_superior_email: 's@wct.my' });
    assert.equal(same.status, 400);
    const noSup = await api('post', '/cases', HR_LAND, { employee_email: 'nosup@wct.my', employee_name: 'N', business_unit: 'Land' });
    assert.equal(noSup.status, 400);
    assert.match(noSup.body.error, /superior email is required/i);
    const early = await api('post', '/cases', HR_LAND, { employee_email: 'early@wct.my', employee_name: 'E', business_unit: 'Land',
      immediate_superior_email: 'boss@wct.my', official_last_day: '2026-12-31', actual_last_day: '2026-12-30' });
    assert.equal(early.status, 400);
    assert.match(early.body.error, /cannot be before the official last day/);
    await invite(HR_LAND, { employee_email: 'dup@wct.my' });
    const dup = await api('post', '/cases', HR_LAND, { employee_email: 'DUP@wct.my', employee_name: 'Dup', business_unit: 'Land', immediate_superior_email: 'boss@wct.my' });
    assert.equal(dup.status, 409);
  });
});

describe('list, counts and scope', () => {
  test('HR sees own BU only; super sees all; switching BU session follows scope (RF#2)', async () => {
    const land = await invite(HR_LAND);
    const mall = await invite(HR_LAND_AS_MALL, { business_unit: 'Mall' });
    const l = await api('get', '/cases?page_size=200', HR_LAND);
    assert.ok(l.body.rows.some((r) => r.id === land.id));
    assert.ok(!l.body.rows.some((r) => r.id === mall.id));
    const m = await api('get', '/cases?page_size=200', HR_LAND_AS_MALL);
    assert.ok(m.body.rows.some((r) => r.id === mall.id));
    assert.ok(!m.body.rows.some((r) => r.id === land.id));
    assert.equal((await api('get', `/cases/${land.id}`, HR_LAND_AS_MALL)).status, 404);
    const s = await api('get', '/cases?page_size=200&business_unit=Mall', SUPER);
    assert.ok(s.body.rows.every((r) => r.business_unit === 'Mall'));
  });

  test('filters: q, status, due, mine; counts', async () => {
    const a = await invite(HR_LAND, { employee_name: 'Zulkifli Unique' });
    const b = await submitted(await invite(HR_LAND));
    await db().query("UPDATE offboarding_cases SET actual_last_day = '2020-01-01' WHERE id = $1", [b.case.id]);

    const q = await api('get', '/cases?q=zulkifli', HR_LAND);
    assert.deepEqual(q.body.rows.map((r) => r.id), [a.id]);
    const st = await api('get', '/cases?status=clearance_in_progress&page_size=200', HR_LAND);
    assert.ok(st.body.rows.every((r) => r.status === 'clearance_in_progress'));
    const od = await api('get', '/cases?due=overdue&page_size=200', HR_LAND);
    assert.ok(od.body.rows.some((r) => r.id === b.case.id && r.overdue === true));
    assert.ok(od.body.counts.overdue >= 1);
    assert.ok(od.body.counts.invited >= 1);

    const pic = await api('get', '/cases?page_size=200', IT_LAND);
    assert.ok(pic.body.rows.some((r) => r.id === b.case.id));
    assert.ok(!pic.body.rows.some((r) => r.id === a.id), 'PIC should not see invited cases');
    const row = pic.body.rows.find((r) => r.id === b.case.id);
    assert.equal(row.sections_signed, 0);
    assert.equal(row.sections_total, 6);
    assert.match(row.waiting_on, /IT/);
    const mine = await api('get', '/cases?mine=1&page_size=200', IT_LAND);
    assert.ok(mine.body.rows.some((r) => r.id === b.case.id));
  });

  test('payroll PIC sees BU cases read-only; other-BU payroll gets 404', async () => {
    const b = await submitted(await invite());
    assert.equal((await api('get', `/cases/${b.case.id}`, PAY_LAND)).status, 200);
    assert.equal((await api('put', `/cases/${b.case.id}/sections/2`, PAY_LAND, { items: [] })).status, 403);
    assert.equal((await api('get', `/cases/${b.case.id}`, PAY_MALL)).status, 404);
  });

  test('CSV export', async () => {
    const res = await api('get', '/cases/export.csv', HR_LAND);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    const lines = res.text.trim().split('\n');
    assert.match(lines[0], /^Reference,Employee,Email/);
    assert.ok(lines.length > 1);
    assert.equal((await api('get', '/cases/export.csv', IT_LAND)).status, 403);
  });
});

describe('case detail and edits', () => {
  test('detail includes permissions; invite link only for HR', async () => {
    const c = await invite();
    const hr = await api('get', `/cases/${c.id}`, HR_LAND);
    assert.equal(hr.body.can.resend_invite, true);
    assert.match(hr.body.invite_link, /index\.html\?offboard=/);
    const b = await submitted(c);
    const pay = await api('get', `/cases/${b.case.id}`, PAY_LAND);
    assert.equal(pay.body.invite_link, undefined);
    assert.equal(pay.body.case.invite_token, undefined);
    const it = await api('get', `/cases/${b.case.id}`, IT_LAND);
    assert.equal(it.body.sections.find((s) => s.department_id === 2).can_edit, true);
    assert.equal(it.body.sections.find((s) => s.department_id === 4).can_edit, false);
  });

  test('PATCH details; superior change moves RU assignee only while unsigned', async () => {
    const b = await submitted(await invite());
    const res = await api('patch', `/cases/${b.case.id}`, HR_LAND, { position: 'Senior Engineer', immediate_superior_email: 'NewBoss@wct.my' });
    assert.equal(res.status, 200);
    assert.equal(res.body.case.position, 'Senior Engineer');
    const ru = res.body.sections.find((s) => s.department_id === 1);
    assert.equal(ru.assignee_email, 'newboss@wct.my');
    assert.ok(res.body.events.some((e) => e.event_type === 'details_updated'));
    await api('put', `/cases/${b.case.id}/sections/1`, HR_LAND, { items: [], sign: { name: 'X' }, on_behalf: true });
    const again = await api('patch', `/cases/${b.case.id}`, HR_LAND, { immediate_superior_email: 'third@wct.my' });
    assert.equal(again.body.sections.find((s) => s.department_id === 1).assignee_email, 'newboss@wct.my');
    assert.equal((await api('patch', `/cases/${b.case.id}`, IT_LAND, { position: 'x' })).status, 403);
    // actual (2026-12-31) can't move before official, and official can't move past actual
    assert.equal((await api('patch', `/cases/${b.case.id}`, HR_LAND, { actual_last_day: '2026-12-30' })).status, 400);
    assert.equal((await api('patch', `/cases/${b.case.id}`, HR_LAND, { official_last_day: '2027-01-05' })).status, 400);
    assert.equal((await api('patch', `/cases/${b.case.id}`, HR_LAND, { official_last_day: '2026-12-31' })).status, 200);
    assert.equal((await api('patch', `/cases/${b.case.id}`, HR_LAND, { immediate_superior_email: '' })).status, 400);
  });

  test('resend invite only while invited; cancel needs reason and emails employee', async () => {
    const c = await invite();
    assert.equal((await api('post', `/cases/${c.id}/resend-invite`, HR_LAND)).status, 200);
    assert.equal(pa.byEvent('invite_resent').length, 1);
    assert.equal((await api('post', `/cases/${c.id}/cancel`, HR_LAND, {})).status, 400);
    const x = await api('post', `/cases/${c.id}/cancel`, HR_LAND, { reason: 'Resignation withdrawn' });
    assert.equal(x.status, 200);
    assert.equal(x.body.case.status, 'cancelled');
    assert.equal(pa.byEvent('cancelled').length, 1);
    assert.equal((await api('post', `/cases/${c.id}/resend-invite`, HR_LAND)).status, 409);
    // A cancelled case frees the email for a new invite.
    await invite(HR_LAND, { employee_email: c.employee_email });
  });
});

describe('clearance', () => {
  test('PIC saves then signs; own-case blocked; HR on behalf flagged; 6th sign → pending_acknowledgement', async () => {
    const b = await submitted(await invite());
    const itSec = b.sections.find((s) => s.department_id === 2);
    const items = itSec.items.map((i, idx) => ({ id: i.id, is_checked: idx === 0, remarks: idx === 0 ? 'Laptop returned' : null }));
    const save = await api('put', `/cases/${b.case.id}/sections/2`, IT_LAND, { items });
    assert.equal(save.status, 200);
    const saved = save.body.sections.find((s) => s.department_id === 2);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.items[0].is_checked, true);
    assert.equal(saved.items[0].remarks, 'Laptop returned');

    const noName = await api('put', `/cases/${b.case.id}/sections/2`, IT_LAND, { items: [], sign: { name: ' ' } });
    assert.equal(noName.status, 400);
    const sign = await api('put', `/cases/${b.case.id}/sections/2`, IT_LAND, { items: [], sign: { name: 'Ali IT' } });
    assert.equal(sign.status, 200);
    const signed = sign.body.sections.find((s) => s.department_id === 2);
    assert.equal(signed.status, 'complete');
    assert.equal(signed.signed_by_email, 'it.land@wct.my');
    assert.equal(signed.signed_on_behalf, false);
    assert.equal((await api('put', `/cases/${b.case.id}/sections/2`, IT_LAND, { items: [] })).status, 409);

    const notOwner = await api('put', `/cases/${b.case.id}/sections/4`, HR_LAND, { items: [], sign: { name: 'HR' } });
    assert.equal(notOwner.status, 403);
    for (const d of [1, 3, 4, 5]) {
      await api('put', `/cases/${b.case.id}/sections/${d}`, HR_LAND, { items: [], sign: { name: 'HR' }, on_behalf: true });
    }
    pa.reset();
    const last = await api('put', `/cases/${b.case.id}/sections/6`, HR_LAND, { items: [], sign: { name: 'HR' }, on_behalf: true });
    assert.equal(last.body.case.status, 'pending_acknowledgement');
    assert.equal(last.body.sections.find((s) => s.department_id === 6).signed_on_behalf, true);
    assert.equal(pa.byEvent('ready_to_ack').length, 1);
  });

  test('nobody signs their own case', async () => {
    const b = await submitted(await invite(HR_LAND, { employee_email: 'it.land@wct.my' }));
    const res = await api('put', `/cases/${b.case.id}/sections/2`, IT_LAND, { items: [], sign: { name: 'Me' } });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /own/i);
  });

  test('superior signs the Reporting Unit only; my-tasks has no duplicates (RF#3)', async () => {
    const b = await submitted(await invite());
    const mt = await api('get', '/my-tasks', SUPERIOR);
    assert.ok(mt.body.sections.some((s) => s.case_id === b.case.id && s.department_id === 1));
    assert.equal((await api('put', `/cases/${b.case.id}/sections/2`, SUPERIOR, { items: [], sign: { name: 'S' } })).status, 403);
    assert.equal((await api('put', `/cases/${b.case.id}/sections/1`, SUPERIOR, { items: [], sign: { name: 'Sue' } })).status, 200);

    const c = await submitted(await invite(HR_LAND, { immediate_superior_email: 'it.land@wct.my' }));
    const both = await api('get', '/my-tasks', IT_AND_SUPERIOR);
    const forCase = both.body.sections.filter((s) => s.case_id === c.case.id);
    assert.deepEqual(forCase.map((s) => s.department_id).sort(), [1, 2]);
    const listed = await api('get', '/cases?mine=1&page_size=200', IT_AND_SUPERIOR);
    assert.equal(listed.body.rows.filter((r) => r.id === c.case.id).length, 1);
  });

  test('reopen after acknowledgement resets to clearance, no payroll email (RF#5)', async () => {
    const b = await submitted(await invite());
    await signAll(b.case.id);
    await db().query(
      "UPDATE offboarding_cases SET status = 'pending_payroll', acknowledged_at = now(), acknowledged_signature_name = 'L' WHERE id = $1",
      [b.case.id]);
    pa.reset();
    assert.equal((await api('post', `/cases/${b.case.id}/sections/3/reopen`, IT_LAND)).status, 403);
    const res = await api('post', `/cases/${b.case.id}/sections/3/reopen`, HR_LAND, { reason: 'Parking card not returned' });
    assert.equal(res.status, 200);
    assert.equal(res.body.case.status, 'clearance_in_progress');
    assert.equal(res.body.case.acknowledged_at, null);
    assert.equal(res.body.sections.find((s) => s.department_id === 3).status, 'pending');
    assert.equal(pa.byEvent('payroll_action').length, 0);
    assert.ok(res.body.events.some((e) => e.event_type === 'section_reopened'));
  });

  test('manual remind targets pending sections; bulk remind', async () => {
    const b = await submitted(await invite());
    await api('put', `/cases/${b.case.id}/sections/2`, IT_LAND, { items: [], sign: { name: 'Ali' } });
    pa.reset();
    const r = await api('post', `/cases/${b.case.id}/remind`, HR_LAND, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.sent, 5);
    assert.ok(!pa.byEvent('reminder').some((c) => c.body.department === 'IT'));
    const c2 = await submitted(await invite());
    pa.reset();
    const bulk = await api('post', '/cases/remind-bulk', HR_LAND, { case_ids: [b.case.id, c2.case.id] });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.cases, 2);
    assert.equal(pa.byEvent('reminder').length, 11);
  });
});

describe('HR sign-off, payroll, PDFs', () => {
  test('HR Section D only after submit', async () => {
    const c = await invite();
    assert.equal((await api('post', `/cases/${c.id}/hr-signoff`, HR_LAND, { name: 'Nur', position: 'HR Exec' })).status, 409);
    await submitted(c);
    const ok = await api('post', `/cases/${c.id}/hr-signoff`, HR_LAND, { name: 'Nur', position: 'HR Exec', comments: 'Fine' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.exitInterview.hr_signed_name, 'Nur');
    assert.equal((await api('post', `/cases/${c.id}/hr-signoff`, HR_LAND, { name: '', position: 'x' })).status, 400);
  });

  test('payroll done: status and role guards, completion email', async () => {
    const b = await submitted(await invite());
    assert.equal((await api('post', `/cases/${b.case.id}/payroll-done`, PAY_LAND, {})).status, 409);
    await signAll(b.case.id);
    await db().query("UPDATE offboarding_cases SET status = 'pending_payroll', acknowledged_at = now() WHERE id = $1", [b.case.id]);
    assert.equal((await api('post', `/cases/${b.case.id}/payroll-done`, IT_LAND, {})).status, 403);
    assert.equal((await api('post', `/cases/${b.case.id}/payroll-done`, PAY_MALL, {})).status, 404);
    pa.reset();
    const ok = await api('post', `/cases/${b.case.id}/payroll-done`, PAY_LAND, { remarks: 'Paid with Oct payroll' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.case.status, 'completed');
    assert.equal(ok.body.case.payroll_completed_by_email, 'pay.land@wct.my');
    assert.equal(pa.byEvent('completed').length, 1);
  });

  test('PDF endpoints', async () => {
    const c = await invite();
    assert.equal((await api('get', `/cases/${c.id}/pdf/exit-interview`, HR_LAND)).status, 409);
    const b = await submitted(c);
    const ei = await api('get', `/cases/${c.id}/pdf/exit-interview`, HR_LAND).buffer(true);
    assert.equal(ei.status, 200);
    assert.match(ei.headers['content-type'], /application\/pdf/);
    assert.equal((await api('get', `/cases/${c.id}/pdf/clearance`, HR_LAND)).status, 409);
    await signAll(b.case.id);
    await db().query("UPDATE offboarding_cases SET status = 'pending_payroll' WHERE id = $1", [c.id]);
    const cl = await api('get', `/cases/${c.id}/pdf/clearance`, PAY_LAND).buffer(true);
    assert.equal(cl.status, 200);
  });

  test('my-tasks for payroll lists pending_payroll cases', async () => {
    const b = await submitted(await invite());
    await signAll(b.case.id);
    await db().query("UPDATE offboarding_cases SET status = 'pending_payroll' WHERE id = $1", [b.case.id]);
    const res = await api('get', '/my-tasks', PAY_LAND);
    assert.ok(res.body.payroll.some((c) => c.id === b.case.id));
    assert.equal(typeof res.body.count, 'number');
  });
});
