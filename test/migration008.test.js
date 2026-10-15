'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, applyMigration, db } = require('./helpers/db');
const fx = require('./helpers/fixtures');

let landApp;

before(async () => {
  await resetDb({ stopBefore: '008' });
  // The live database as it is today: three hard-coded units, companies
  // filed by entity category, a configured manager address.
  landApp = await fx.hiredApplication({ email: 'land.person@wct.my', business_unit: 'Land' });
  await db().query(`INSERT INTO companies (name, category, business_unit) VALUES
    ('Grandmama''s Sdn Bhd', 'F&B', 'Mall'), ('Hotel One Sdn Bhd', 'Hotel', 'Land'),
    ('WCT Land Sdn Bhd', 'Property', 'Land'), ('Labur Bina Sdn Bhd', 'Property', 'Land')`);
  await db().query("INSERT INTO manager_settings (manager_email_land) VALUES ('land.mgr@wct.my')");
  await applyMigration('008');
});
after(async () => { await db().pool.end(); });

test('seven business units, old codes kept with new names', async () => {
  const { rows } = await db().query('SELECT code, name, ref_code, pic_email FROM business_units ORDER BY sort_order');
  assert.deepEqual(rows.map((r) => r.code), ['E&C', 'Land', 'Mall', 'REIT', 'Aviation', 'F&B', 'Hotels']);
  assert.equal(rows[1].name, 'Property Development');
  assert.equal(rows[2].name, 'Malls Management');
  assert.equal(rows[1].pic_email, 'land.mgr@wct.my', 'manager address carried over');
  const app = await db().query('SELECT business_unit FROM applications WHERE id = $1', [landApp.id]);
  assert.equal(app.rows[0].business_unit, 'Land');
});

test('new units are accepted and unknown units are refused everywhere', async () => {
  await fx.hiredApplication({ email: 'reit.person@wct.my', business_unit: 'REIT' });
  await assert.rejects(fx.hiredApplication({ email: 'bogus@wct.my', business_unit: 'Bogus' }), /foreign key/);
  await assert.rejects(db().query("INSERT INTO companies (name, business_unit) VALUES ('X', 'Bogus')"), /foreign key/);
});

test('companies move to their entity business unit; missing ones are added once', async () => {
  const { rows } = await db().query('SELECT name, business_unit FROM companies');
  const bu = Object.fromEntries(rows.map((r) => [r.name, r.business_unit]));
  assert.equal(bu["Grandmama's Sdn Bhd"], 'F&B');
  assert.equal(bu['Hotel One Sdn Bhd'], 'Hotels');
  assert.equal(bu['WCT Properties Sdn Bhd'], 'Land');
  assert.equal(bu['RASA by Grandmamas Sdn Bhd'], 'F&B');
  assert.equal(bu['Skypark RAC Sdn Bhd'], 'Aviation');
  assert.equal(rows.filter((r) => r.name === 'Labur Bina Sdn Bhd').length, 1, 'existing company not duplicated');
});

test('payroll PIC may name a business unit or none; super admin still may not', async () => {
  const a = await fx.admin({ email: 'pay@wct.my', grants: [{ role: 'payroll_pic', business_unit: 'Land' }, { role: 'payroll_pic' }] });
  assert.ok(a.id);
  await assert.rejects(fx.admin({ email: 'sup@wct.my', grants: [{ role: 'super_admin', business_unit: 'Land' }] }), /chk_admin_grants_bu_matches_role/);
});

test('form v2 columns exist and the salary company list is open', async () => {
  await db().query(`UPDATE applications SET permanent_address2 = 'Taman A', permanent_city = 'Puchong', permanent_state = 'Selangor',
    no_working_experience = true, spouse_name = 'S', children_below_18 = '[{"name":"K"}]' WHERE id = $1`, [landApp.id]);
  await db().query("INSERT INTO onboarding_records (application_id, salary_company, personal_details_signed_name) VALUES ($1, 'WCT Properties Sdn Bhd', 'Land Person')", [landApp.id]);
});

test('running the migration twice is harmless and keeps dashboard changes', async () => {
  // Changes an admin might make after the first run.
  await db().query("UPDATE companies SET business_unit = 'Mall' WHERE name = 'Hotel One Sdn Bhd'");
  await db().query("DELETE FROM companies WHERE name = 'Skypark RAC Sdn Bhd'");
  await db().query("UPDATE business_units SET pic_email = NULL WHERE code = 'Land'");
  await applyMigration('008');
  const { rows } = await db().query('SELECT count(*)::int AS n FROM business_units');
  assert.equal(rows[0].n, 7);
  const moved = await db().query("SELECT business_unit FROM companies WHERE name = 'Hotel One Sdn Bhd'");
  assert.equal(moved.rows[0].business_unit, 'Mall', 'manual move kept');
  const gone = await db().query("SELECT 1 FROM companies WHERE name = 'Skypark RAC Sdn Bhd'");
  assert.equal(gone.rowCount, 0, 'deleted company not re-added');
  const pic = await db().query("SELECT pic_email FROM business_units WHERE code = 'Land'");
  assert.equal(pic.rows[0].pic_email, null, 'cleared PIC not re-filled');
});
