'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, applyMigration, db } = require('./helpers/db');
const fx = require('./helpers/fixtures');

let signedApp;
let unsignedApp;

before(async () => {
  await resetDb({ stopBefore: '005' });
  // A live database as it looks today: two applications in 'offboarding',
  // one whose exit interview is fully signed (employee + HR), one untouched.
  signedApp = await fx.hiredApplication({ email: 'Signed.Person@wct.my', business_unit: 'Land', name: 'Signed Person' });
  unsignedApp = await fx.hiredApplication({ email: 'unsigned@wct.my', business_unit: 'Mall', name: 'Unsigned Person' });
  await db().query("UPDATE applications SET status = 'offboarding' WHERE id IN ($1, $2)", [signedApp.id, unsignedApp.id]);
  await db().query(
    `INSERT INTO exit_interviews (application_id, position, immediate_superior, dept_site, date_joined, notice_period,
       official_last_day, actual_last_day, reasons, reasons_other_specify, comments,
       employee_signed, employee_signed_name, employee_signed_at, hr_signed, hr_signed_name, hr_signed_position, hr_signed_at)
     VALUES ($1, 'Site Engineer', 'Evelyn', 'Construction', '2022-03-01', '30 days', '2026-11-01', '2026-10-28',
       '["Better Offer"]'::jsonb, 'Family', 'Thanks', true, 'Signed Person', now(), true, 'HR Lead', 'HR Manager', now())`,
    [signedApp.id]
  );
  await db().query('INSERT INTO exit_interviews (application_id) VALUES ($1)', [unsignedApp.id]);
  await applyMigration('005');
});
after(async () => { await db().pool.end(); });

test('reference data is seeded: 6 departments and 45 checklist items', async () => {
  const d = await db().query('SELECT id, name, is_reporting_unit FROM clearance_departments ORDER BY id');
  assert.deepEqual(d.rows.map((r) => r.name), ['Reporting Unit', 'IT', 'Administration', 'Finance', 'Purchasing', 'Human Resources']);
  assert.equal(d.rows[0].is_reporting_unit, true);
  const t = await db().query('SELECT count(*)::int n, count(*) FILTER (WHERE is_other)::int others FROM clearance_checklist_templates');
  assert.equal(t.rows[0].n, 45);
  assert.equal(t.rows[0].others, 18);
});

test('legacy exit interviews become offboarding cases', async () => {
  const { rows } = await db().query('SELECT * FROM offboarding_cases ORDER BY employee_email');
  assert.equal(rows.length, 2);
  const signed = rows.find((r) => r.application_id === signedApp.id);
  const unsigned = rows.find((r) => r.application_id === unsignedApp.id);
  assert.equal(signed.status, 'clearance_in_progress');
  assert.equal(signed.employee_email, 'signed.person@wct.my');
  assert.equal(signed.business_unit, 'Land');
  assert.equal(signed.position, 'Site Engineer');
  assert.equal(signed.department, 'Construction');
  assert.equal(signed.notice_period_days, 30);
  assert.equal(signed.official_last_day, '2026-11-01');
  assert.equal(signed.employee_user_id, signedApp.user_id);
  assert.match(signed.ref_no, /^OFF-\d{4}-\d{4}$/);
  assert.equal(signed.invite_token.length, 64);
  assert.equal(unsigned.status, 'invited');
  assert.equal(unsigned.business_unit, 'Mall');

  const ei = await db().query('SELECT * FROM offboarding_exit_interviews WHERE case_id = $1', [signed.id]);
  assert.deepEqual(ei.rows[0].reasons, ['Better Offer']);
  assert.deepEqual(ei.rows[0].reasons_other, ['Family']);
  assert.equal(ei.rows[0].employee_signature_name, 'Signed Person');
  assert.equal(ei.rows[0].hr_signed_name, 'HR Lead');

  const s = await db().query('SELECT count(*)::int n FROM offboarding_clearance_sections WHERE case_id = $1', [signed.id]);
  assert.equal(s.rows[0].n, 6);
  const i = await db().query(
    'SELECT count(*)::int n FROM offboarding_clearance_items it JOIN offboarding_clearance_sections s ON s.id = it.section_id WHERE s.case_id = $1',
    [signed.id]
  );
  assert.equal(i.rows[0].n, 45);
  const none = await db().query('SELECT count(*)::int n FROM offboarding_clearance_sections WHERE case_id = $1', [unsigned.id]);
  assert.equal(none.rows[0].n, 0);
  const ev = await db().query("SELECT detail FROM offboarding_events WHERE case_id = $1 AND event_type = 'invited'", [signed.id]);
  assert.equal(ev.rows[0].detail.migrated, true);
});

test('applications move back to hired and offboarding status is gone', async () => {
  const { rows } = await db().query('SELECT status FROM applications WHERE id IN ($1, $2)', [signedApp.id, unsignedApp.id]);
  assert.deepEqual(rows.map((r) => r.status), ['hired', 'hired']);
  await assert.rejects(
    db().query("UPDATE applications SET status = 'offboarding' WHERE id = $1", [signedApp.id]),
    /check constraint/
  );
});

test('old table is kept as legacy_exit_interviews', async () => {
  const { rows } = await db().query('SELECT count(*)::int n FROM legacy_exit_interviews');
  assert.equal(rows[0].n, 2);
  const t = await db().query("SELECT to_regclass('public.exit_interviews') AS t");
  assert.equal(t.rows[0].t, null);
});

test('admin_grants accepts the new roles with the right shape', async () => {
  const a = await fx.admin({ email: 'pic@wct.my' });
  const ins = (role, bu, dept) => db().query(
    'INSERT INTO admin_grants (admin_user_id, role, business_unit, department_id) VALUES ($1,$2,$3,$4)',
    [a.id, role, bu, dept]
  );
  await assert.rejects(ins('clearance_pic', 'Land', null), /check constraint/);
  await ins('clearance_pic', 'Land', 2);
  await assert.rejects(ins('payroll_pic', null, null), /check constraint/);
  await ins('payroll_pic', 'Land', null);
  await assert.rejects(ins('bu_admin', 'Land', 2), /check constraint/);
  await assert.rejects(ins('super_admin', null, 2), /check constraint/);
});

test('re-running migration 005 changes nothing', async () => {
  const before = await db().query(
    `SELECT (SELECT count(*) FROM offboarding_cases)::int c, (SELECT count(*) FROM clearance_checklist_templates)::int t,
            (SELECT count(*) FROM offboarding_clearance_items)::int i`
  );
  await applyMigration('005');
  const afterRun = await db().query(
    `SELECT (SELECT count(*) FROM offboarding_cases)::int c, (SELECT count(*) FROM clearance_checklist_templates)::int t,
            (SELECT count(*) FROM offboarding_clearance_items)::int i`
  );
  assert.deepEqual(afterRun.rows[0], before.rows[0]);
});
