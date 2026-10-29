#!/usr/bin/env node
'use strict';
// =============================================================================
// Check (and if needed re-send) the emails for a submitted application.
//
//   cd /opt/wct/backend
//   sudo node scripts/check-submit-emails.js                          settings only
//   sudo node scripts/check-submit-emails.js WCT-LAND-2026-000002     + who gets emailed
//   sudo node scripts/check-submit-emails.js WCT-LAND-2026-000002 --send
//                                                                     re-send both emails
//
// Reads /etc/wct/backend.env (or ENV_FILE). Never prints flow URLs or secrets.
// Power Automate answers 202 as soon as it accepts a call; if a step inside
// the flow then fails, only the flow's run history shows it.
// =============================================================================
const fs = require('fs');
const path = require('path');

const envFile = process.env.ENV_FILE || '/etc/wct/backend.env';
if (fs.existsSync(envFile)) require('dotenv').config({ path: envFile });
else console.log(`(no ${envFile}; using this shell's environment)`);

const root = path.join(__dirname, '..');
const db = require(path.join(root, 'src/db'));
const { sendSubmissionEmails, submissionRecipients, candidateEmailOn } = require(path.join(root, 'src/lib/submissionEmails'));

const [ref, flag] = process.argv.slice(2);
const set = (k) => (process.env[k] ? 'set' : 'MISSING');
const show = (r) => (r.ok ? `sent (Power Automate replied ${r.status})`
  : r.skipped ? `not sent: ${r.skipped.replace(/_/g, ' ')}`
    : r.error ? `not sent: ${r.error}` : `not sent: Power Automate replied ${r.status}`);

(async () => {
  console.log('Settings');
  console.log(`  POWER_AUTOMATE_URL_SUBMIT ............ ${set('POWER_AUTOMATE_URL_SUBMIT')}   (HR "new application" email)`);
  console.log(`  POWER_AUTOMATE_URL_OFFBOARDING_EMAIL . ${set('POWER_AUTOMATE_URL_OFFBOARDING_EMAIL')}   (generic email flow)`);
  console.log(`  CANDIDATE_CONFIRMATION_EMAIL ......... ${candidateEmailOn() ? 'on  -> the server emails the candidate' : 'off -> only the Submit flow can email the candidate'}`);
  if (!ref) { await db.pool.end(); return; }

  const { rows } = await db.query('SELECT * FROM applications WHERE reference_no = $1', [ref]);
  const app = rows[0];
  if (!app) { console.log(`\nNo application ${ref}.`); await db.pool.end(); process.exitCode = 1; return; }
  const { unit, notifyEmail } = await submissionRecipients(app);
  console.log(`\nApplication ${ref}`);
  console.log(`  status ${app.status}, submitted ${app.submitted_at ? new Date(app.submitted_at).toISOString() : 'never'}`);
  console.log(`  business unit ${app.business_unit} (${unit ? unit.name : 'unit not readable'}), PIC email ${unit && unit.pic_email ? unit.pic_email : 'none set'}`);
  console.log(`  HR email goes to ....... ${notifyEmail || 'NOBODY (no HR admin, super admin or PIC email found)'}`);
  console.log(`  candidate email goes to  ${app.email || 'no email on the application'}`);

  if (flag === '--send') {
    if (app.status === 'draft') { console.log('\nStill a draft: nothing to re-send.'); await db.pool.end(); return; }
    const r = await sendSubmissionEmails(app);
    console.log('\nRe-sent');
    console.log(`  HR notification ........ ${show(r.hr || { ok: false })}`);
    console.log(`  candidate confirmation . ${show(r.candidate)}`);
    console.log('Now open each flow\'s 28-day run history in Power Automate to confirm the run succeeded.');
  } else {
    console.log('\nAdd --send to re-send both emails for this application.');
  }
  await db.pool.end();
})().catch(async (err) => { console.error('Error:', err.message); process.exitCode = 1; try { await db.pool.end(); } catch (e) { /* ignore */ } });
