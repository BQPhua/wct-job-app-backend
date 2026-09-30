'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');

const SUPER = `Bearer ${fx.adminToken({ email: 'boss@wct.my', unit_scope: 'ALL' })}`;
let app;

before(async () => {
  await resetDb();
  app = await fx.hiredApplication({ email: 'hired@wct.my', business_unit: 'Land' });
});
after(async () => { await db().pool.end(); });

test('old candidate exit-interview routes are gone', async () => {
  const cand = await fx.candidate({ email: 'c@wct.my' });
  const res = await request().get(`/api/exit-interviews/${app.id}`).set('Authorization', `Bearer ${cand.token}`);
  assert.equal(res.status, 404);
});

test('old admin offboarding routes are gone', async () => {
  const calls = [
    request().post(`/api/admin/applications/${app.id}/offboarding`),
    request().post(`/api/admin/exit-interviews/${app.id}/sign`).send({ hr_name: 'x', hr_position: 'y' }),
    request().get(`/api/admin/applications/${app.id}/exit-interview`),
    request().get('/api/admin/exit-interviews/pending-count'),
  ];
  for (const c of calls) {
    const res = await c.set('Authorization', SUPER);
    assert.equal(res.status, 404, `${res.req.method} ${res.req.path} → ${res.status}`);
  }
});

test("'offboarding' is no longer a settable application status", async () => {
  const res = await request().post(`/api/admin/applications/${app.id}/status`).set('Authorization', SUPER).send({ status: 'offboarding' });
  assert.equal(res.status, 400);
});

test('no backend source still touches the legacy table or event', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const offenders = walk(path.join(__dirname, '..', 'src'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /\bexit_interviews\b|POWER_AUTOMATE_URL_EXIT_INTERVIEW|notify\('exit_interview'/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'routes', 'exitInterview.js')), false);
});
