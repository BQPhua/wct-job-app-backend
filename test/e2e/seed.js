'use strict';
// Fresh `wct_e2e` database with staff accounts and a spread of offboarding
// cases, so every dashboard state is visible. Prints the ids the Playwright
// script needs as JSON.
process.env.E2E_DB = process.env.E2E_DB || 'wct_e2e';
require('../helpers/env');
const { resetDb, db } = require('../helpers/db');
const fx = require('../helpers/fixtures');
const lifecycle = require('../../src/lib/offboarding/lifecycle');
const { addDays, todayMYT } = require('../../src/lib/offboarding/dates');

(async () => {
  await resetDb();
  const t = todayMYT();
  await fx.admin({ email: 'boss@wct.my', name: 'Super Boss', grants: [{ role: 'super_admin' }] });
  await fx.admin({ email: 'hr.land@wct.my', name: 'Nur HR', grants: [{ role: 'bu_admin', business_unit: 'Land' }] });
  await fx.admin({ email: 'it.land@wct.my', name: 'Ali IT', grants: [{ role: 'clearance_pic', business_unit: 'Land', department_id: 2 }] });
  await fx.admin({ email: 'pay.land@wct.my', name: 'Pay Roll', grants: [{ role: 'payroll_pic', business_unit: 'Land' }] });
  await db().query("INSERT INTO companies (name, category, business_unit) VALUES ('WCT Land Sdn Bhd','Property','Land'), ('WCT Construction Sdn Bhd','E&C','E&C')");
  const hired = await fx.hiredApplication({ email: 'aina.ali@wct.my', business_unit: 'Land', name: 'Aina Binti Ali', position: 'Site Engineer' });
  const employee = await db().query('SELECT id FROM users WHERE email = $1', ['aina.ali@wct.my']);
  // A spread of job applications for the dashboard.
  const apps = [['Nurul Izzah', 'submitted', 'Quantity Surveyor'], ['Kevin Tan', 'shortlisted', 'Project Manager'], ['Priya Devi', 'kiv', 'Safety Officer'],
    ['Ahmad Faiz', 'rejected', 'Site Supervisor'], ['Lim Wei Jie', 'submitted', 'Architect'], ['Farah Aziz', 'hired', 'HR Executive']];
  for (const [name, status, pos] of apps) {
    const a = await fx.hiredApplication({ email: `${name.toLowerCase().replace(/\s+/g, '.')}@gmail.com`, business_unit: 'Land', name, position: pos });
    await db().query("UPDATE applications SET status = $2, submitted_at = now() - interval '3 days', mobile_phone = '0123456789' WHERE id = $1", [a.id, status]);
  }

  // Background cases in various states.
  const mk = async (name, status, lastDayOffset, bu = 'Land', signed = 0) => db().withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO offboarding_cases (ref_no, invite_token, employee_email, employee_name, business_unit, status, invited_by_email,
         position, department, company_name, date_joined, notice_period_days, official_last_day, actual_last_day, submitted_at,
         acknowledged_at, payroll_completed_at, immediate_superior_name, immediate_superior_email)
       VALUES ($1,$2,$3,$4,$5,$6,'hr.land@wct.my','Executive','Finance','WCT Land Sdn Bhd','2020-01-06',30,$7,$7,
         CASE WHEN $6 <> 'invited' THEN now() END,
         CASE WHEN $6 IN ('pending_payroll','completed') THEN now() END,
         CASE WHEN $6 = 'completed' THEN now() END, 'Mr Lee', 'mr.lee@wct.my') RETURNING *`,
      [await lifecycle.nextRefNo(client), fx.randomToken(), `${name.toLowerCase().replace(/\s+/g, '.')}@wct.my`, name, bu, status, addDays(t, lastDayOffset)]
    );
    await client.query("INSERT INTO offboarding_exit_interviews (case_id, reasons, comments, employee_signature_name, employee_signed_at) VALUES ($1, '[\"Better Offer\",\"Career Advancement\"]', 'Great team.', $2, CASE WHEN $3 <> 'invited' THEN now() END)", [rows[0].id, name, status]);
    if (status !== 'invited') {
      await lifecycle.createSections(client, rows[0]);
      await client.query(`UPDATE offboarding_clearance_sections SET status='complete', signed_by_name='Seed Signer', signed_by_email='seed@wct.my', signed_at=now()
                           WHERE case_id=$1 AND department_id > $2`, [rows[0].id, status === 'clearance_in_progress' ? 6 - signed : 0]);
    }
    await lifecycle.logEvent(client, rows[0].id, { email: 'hr.land@wct.my', unitScope: 'Land', roles: { bu_admin: true } }, 'invited', {});
    return rows[0];
  });
  await mk('Farid Hassan', 'clearance_in_progress', 5, 'Land', 3);
  await mk('Mei Ling Tan', 'clearance_in_progress', -2, 'Land', 4);
  await mk('Raj Kumar', 'invited', 20);
  await mk('Siti Nur', 'pending_acknowledgement', 2);
  await mk('Daniel Wong', 'pending_payroll', -1);
  await mk('Hafiz Omar', 'completed', -10);
  await mk('Grace Lim', 'clearance_in_progress', 12, 'Mall', 1);

  process.stdout.write(JSON.stringify({ hired_application_id: hired.id, employee_user_id: employee.rows[0].id }));
  await db().pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
