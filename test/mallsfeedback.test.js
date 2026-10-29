'use strict';
// Malls feedback on the e-application form (29 Oct 2026):
//   REIT merged into Malls (migration 009), "N/A" language rating,
//   "I have no referee" flag, and a "Declaration details" document section.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, applyMigration, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');

const year = new Date().getUTCFullYear();
let reitApp; let picker; let both;

before(async () => {
  // The live database before 009: REIT is its own unit with its own people.
  await resetDb({ stopBefore: '009' });
  reitApp = await fx.hiredApplication({ email: 'reit.hire@wct.my', business_unit: 'REIT' });
  await db().query("INSERT INTO companies (name, business_unit) VALUES ('WCT REIT Management Sdn Bhd', 'REIT')");
  await db().query("UPDATE business_units SET pic_email = 'reit.hr@wct.my' WHERE code = 'REIT'");
  await db().query("UPDATE business_units SET pic_email = 'malls.hr@wct.my' WHERE code = 'Mall'");
  picker = await fx.admin({ email: 'reit.only@wct.my', grants: [{ role: 'bu_admin', business_unit: 'REIT' }] });
  both = await fx.admin({ email: 'malls.and.reit@wct.my', grants: [{ role: 'bu_admin', business_unit: 'REIT' }, { role: 'bu_admin', business_unit: 'Mall' }] });
  await applyMigration('009');
});
after(async () => { await db().pool.end(); });

describe('migration 009: REIT merged into Malls', () => {
  test('REIT records, companies and admin access move to Malls', async () => {
    const app = await db().query('SELECT business_unit, reference_no FROM applications WHERE id = $1', [reitApp.id]);
    assert.equal(app.rows[0].business_unit, 'Mall');
    assert.equal(app.rows[0].reference_no, reitApp.reference_no, 'reference number kept as issued');
    const co = await db().query("SELECT business_unit FROM companies WHERE name = 'WCT REIT Management Sdn Bhd'");
    assert.equal(co.rows[0].business_unit, 'Mall');
    const g1 = await db().query('SELECT business_unit FROM admin_grants WHERE admin_user_id = $1', [picker.id]);
    assert.deepEqual(g1.rows.map((r) => r.business_unit), ['Mall']);
    const g2 = await db().query('SELECT business_unit FROM admin_grants WHERE admin_user_id = $1', [both.id]);
    assert.deepEqual(g2.rows.map((r) => r.business_unit), ['Mall'], 'duplicate grant dropped, not doubled');
  });

  test('REIT is switched off, marked merged, and Malls gets its PIC email', async () => {
    const { rows } = await db().query("SELECT code, is_active, merged_into, pic_email FROM business_units WHERE code IN ('REIT', 'Mall') ORDER BY code");
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    assert.equal(by.REIT.is_active, false);
    assert.equal(by.REIT.merged_into, 'Mall');
    assert.equal(by.Mall.pic_email, 'malls.hr@wct.my;reit.hr@wct.my');
  });

  test('safe to run again', async () => {
    await applyMigration('009');
    const { rows } = await db().query("SELECT pic_email FROM business_units WHERE code = 'Mall'");
    assert.equal(rows[0].pic_email, 'malls.hr@wct.my;reit.hr@wct.my');
  });

  test('old ?bu=REIT links open the Malls form', async () => {
    const cand = await fx.candidate({ email: 'reit.link@gmail.com' });
    const res = await request().post('/api/applications').set('Authorization', `Bearer ${cand.token}`).send({ business_unit: 'REIT' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.reference_no, new RegExp(`^WCT-MALL-${year}-`));
    const row = await db().query('SELECT business_unit FROM applications WHERE id = $1', [res.body.id]);
    assert.equal(row.rows[0].business_unit, 'Mall');
  });

  test('candidate pages see Malls with REIT as an alias, and no REIT unit', async () => {
    const res = await request().get('/api/business-units');
    assert.equal(res.status, 200);
    assert.ok(!res.body.some((u) => u.code === 'REIT'));
    assert.deepEqual(res.body.find((u) => u.code === 'Mall').aliases, ['REIT', 'REIT']);
  });
});

describe('form changes', () => {
  let cand; let draft;
  before(async () => {
    cand = await fx.candidate({ email: 'form.change@gmail.com' });
    draft = (await request().post('/api/applications').set('Authorization', `Bearer ${cand.token}`).send({ business_unit: 'Mall' })).body;
  });
  const patch = (p) => request().patch(`/api/applications/${draft.id}`).set('Authorization', `Bearer ${cand.token}`).send({ reference_no: draft.reference_no, patch: p });

  test('a language can be rated N/A', async () => {
    const res = await patch({ language_ability: [{ language: 'Bahasa Malaysia', spoken: 'Good', written: 'Good' }, { language: 'English', spoken: 'Good', written: 'Fair' }, { language: 'Hokkien', spoken: 'Fair', written: 'N/A' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.language_ability[2].written, 'N/A');
    assert.equal((await patch({ language_ability: [{ language: 'X', spoken: 'Excellent', written: '' }] })).status, 400);
  });

  test('"I have no referee" is saved', async () => {
    const res = await patch({ no_referees: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.no_referees, true);
  });

  test('documents can be filed under Declaration details', async () => {
    const res = await patch({ attachments: [{ name: 'declaration.pdf', url: '/api/files/attachments/u/declaration.pdf?exp=2107340964&sig=abc', type: 'application/pdf', category: 'declaration' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.attachments[0].category, 'declaration');
  });
});
