'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');

before(async () => { await resetDb(); });
after(async () => { await db().pool.end(); });

test('GET /api/health returns ok', async () => {
  const res = await request().get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('fresh test database has no applications', async () => {
  const { rows } = await db().query('SELECT count(*)::int AS n FROM applications');
  assert.equal(rows[0].n, 0);
});
