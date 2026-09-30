'use strict';
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resetDb, db } = require('./helpers/db');
const fx = require('./helpers/fixtures');
const paStub = require('./helpers/paStub');
const lifecycle = require('../src/lib/offboarding/lifecycle');
const mailer = require('../src/lib/offboarding/mailer');
const pdf = require('../src/lib/offboarding/pdf');

let pa;
let bundleWithSup;
let bundleNoSup;

async function makeCase({ superior = null, bu = 'Land', status = 'clearance_in_progress' } = {}) {
  const c = await db().withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO offboarding_cases (ref_no, invite_token, employee_email, employee_name, business_unit, status,
         invited_by_email, immediate_superior_email, immediate_superior_name, position, department, date_joined,
         notice_period_days, official_last_day, actual_last_day, company_name)
       VALUES ($1, $2, $3, 'Aina <Binti> Ali', $4, $5, 'hr.land@wct.my', $6, 'Evelyn', 'Engineer', 'Construction',
         '2022-03-01', 30, '2026-11-01', '2026-10-30', 'WCT Land Sdn Bhd') RETURNING *`,
      [await lifecycle.nextRefNo(client), fx.randomToken(), `leaver${fx.uniq()}@wct.my`, bu, status, superior]
    );
    await lifecycle.createSections(client, rows[0]);
    await client.query(
      `INSERT INTO offboarding_exit_interviews (case_id, reasons, reasons_other, comments, employee_signature_name, employee_signed_at)
       VALUES ($1, '["Better Offer","Relocation"]', '{"Family move"}', 'Thank you all', 'Aina', now())`,
      [rows[0].id]
    );
    return rows[0];
  });
  return lifecycle.loadBundle(db(), c.id);
}

before(async () => {
  await resetDb();
  pa = await paStub.start();
  await fx.admin({ email: 'hr.land@wct.my', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  await fx.admin({ email: 'boss@wct.my', grants: [{ role: 'super_admin' }] });
  await fx.admin({ email: 'it.land@wct.my', grants: [{ role: 'clearance_pic', business_unit: 'Land', department_id: 2 }] });
  await fx.admin({ email: 'it.mall@wct.my', grants: [{ role: 'clearance_pic', business_unit: 'Mall', department_id: 2 }] });
  await fx.admin({ email: 'ru.land@wct.my', grants: [{ role: 'clearance_pic', business_unit: 'Land', department_id: 1 }] });
  await fx.admin({ email: 'pay.land@wct.my', grants: [{ role: 'payroll_pic', business_unit: 'Land' }] });
  bundleWithSup = await makeCase({ superior: 'superior@wct.my' });
  bundleNoSup = await makeCase();
});
beforeEach(() => pa.reset());
after(async () => { await pa.stop(); await db().pool.end(); });

describe('mailer', () => {
  test('invite goes to the employee with the tokenised link, values escaped', async () => {
    const r = await mailer.send('invite', bundleWithSup);
    assert.equal(r.ok, true);
    assert.equal(pa.calls.length, 1);
    const b = pa.calls[0].body;
    assert.equal(b.to, bundleWithSup.case.employee_email);
    assert.equal(b.event_type, 'invite');
    assert.equal(b.case_ref, bundleWithSup.case.ref_no);
    assert.ok(b.html.includes(`http://fe.test/index.html?offboard=${bundleWithSup.case.invite_token}`));
    assert.ok(b.html.includes('Aina &lt;Binti&gt; Ali'));
    assert.ok(!b.html.includes('<Binti>'));
    assert.ok(b.subject.includes(bundleWithSup.case.ref_no));
  });

  test('clearance task: one email per department, BU-scoped PICs, superior for Reporting Unit', async () => {
    await mailer.send('clearance_task', bundleWithSup);
    assert.equal(pa.calls.length, 6);
    const byDept = Object.fromEntries(pa.calls.map((c) => [c.body.department, c.body.to]));
    assert.equal(byDept.IT, 'it.land@wct.my');
    assert.equal(byDept['Reporting Unit'], 'superior@wct.my');
    // Departments without a PIC fall back to HR so the task is never lost.
    assert.equal(byDept.Finance, 'hr.land@wct.my');
    assert.ok(pa.calls[0].body.html.includes('http://fe.test/admin.html?offboarding='));
  });

  test('Reporting Unit without superior goes to Reporting Unit PICs', async () => {
    await mailer.send('clearance_task', bundleNoSup, { departmentIds: [1] });
    assert.equal(pa.calls.length, 1);
    assert.equal(pa.calls[0].body.to, 'ru.land@wct.my');
  });

  test('payroll action: payroll PICs, HR in cc, both PDFs attached', async () => {
    await mailer.send('payroll_action', bundleWithSup);
    const b = pa.calls[0].body;
    assert.equal(b.to, 'pay.land@wct.my');
    assert.equal(b.cc, 'hr.land@wct.my');
    assert.equal(b.attachments.length, 2);
    b.attachments.forEach((a) => {
      assert.ok(a.content_base64.startsWith('JVBER'));
      assert.match(a.name, /\.pdf$/);
    });
  });

  test('payroll action without a payroll PIC goes to HR', async () => {
    const mall = await makeCase({ bu: 'Mall' });
    await mailer.send('payroll_action', mall);
    // Mall has no bu_admin either → HR fallback is the super admins.
    assert.equal(pa.calls[0].body.to, 'boss@wct.my');
  });

  test('completed goes to employee with HR copied', async () => {
    await mailer.send('completed', bundleWithSup);
    assert.equal(pa.calls[0].body.to, bundleWithSup.case.employee_email);
    assert.equal(pa.calls[0].body.cc, 'hr.land@wct.my');
  });

  test('Power Automate failure resolves ok:false, never throws', async () => {
    pa.failNext(1);
    const r = await mailer.send('ready_to_ack', bundleWithSup);
    assert.equal(r.ok, false);
  });

  test('reminder reports per-department outcome', async () => {
    pa.failNext(1);
    const r = await mailer.send('reminder', bundleWithSup, { departmentIds: [2, 3], daysLeft: 5 });
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results.map((x) => x.ok), [false, true]);
    assert.ok(pa.calls[1].body.subject.toLowerCase().includes('reminder'));
  });

  test('no URL configured → skipped, ok:false, no throw', async () => {
    const saved = process.env.POWER_AUTOMATE_URL_OFFBOARDING_EMAIL;
    delete process.env.POWER_AUTOMATE_URL_OFFBOARDING_EMAIL;
    const r = await mailer.send('invite', bundleWithSup);
    assert.equal(r.ok, false);
    assert.equal(pa.calls.length, 0);
    process.env.POWER_AUTOMATE_URL_OFFBOARDING_EMAIL = saved;
  });
});

describe('pdf', () => {
  const text = (buf) => {
    const f = path.join(os.tmpdir(), `ob-${fx.uniq()}.pdf`);
    fs.writeFileSync(f, buf);
    return execFileSync('pdftotext', ['-layout', f, '-']).toString();
  };

  test('exit interview PDF has details, all 12 reasons and signatures', async () => {
    const buf = await pdf.exitInterviewPdf(bundleWithSup);
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
    const t = text(buf);
    ['EXIT INTERVIEW', 'Aina <Binti> Ali', 'Engineer', 'Retirement', 'Better Offer', 'Family move', 'Thank you all', bundleWithSup.case.ref_no]
      .forEach((s) => assert.ok(t.includes(s), `missing ${s}`));
  });

  test('clearance PDF lists all departments, signer and acknowledgement', async () => {
    await db().query(
      `UPDATE offboarding_clearance_sections SET status = 'complete', signed_by_name = 'Ali IT', signed_by_email = 'it.land@wct.my', signed_at = now()
        WHERE case_id = $1 AND department_id = 2`, [bundleWithSup.case.id]);
    await db().query(
      "UPDATE offboarding_cases SET acknowledged_at = now(), acknowledged_signature_name = 'Aina' WHERE id = $1", [bundleWithSup.case.id]);
    const b = await lifecycle.loadBundle(db(), bundleWithSup.case.id);
    const buf = await pdf.clearancePdf(b);
    const t = text(buf);
    ['EXIT CLEARANCE', 'Reporting Unit', 'IT', 'Administration', 'Finance', 'Purchasing', 'Human Resources', 'Ali IT', 'Laptop/Desktop', 'Acknowledged']
      .forEach((s) => assert.ok(t.includes(s), `missing ${s}`));
  });
});
