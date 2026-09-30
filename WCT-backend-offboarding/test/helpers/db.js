'use strict';
require('./env');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DB_DIR = path.join(__dirname, '..', '..', 'db');

function adminClient(database) {
  return new Client({
    host: process.env.PGHOST, port: Number(process.env.PGPORT),
    user: process.env.PGUSER, password: process.env.PGPASSWORD, database,
  });
}

function migrationFiles() {
  return fs.readdirSync(path.join(DB_DIR, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Drop and recreate `wct_test`, then apply schema.sql, every migration in
 * order and seed.sql. `stopBefore: '005'` stops before the first migration
 * whose filename starts with that prefix (used by the migration test to
 * build a "live database as it is today" and then apply one migration).
 */
async function resetDb({ stopBefore } = {}) {
  const c = adminClient('postgres');
  await c.connect();
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = $1 AND pid <> pg_backend_pid()`, [process.env.PGDATABASE]);
  await c.query(`DROP DATABASE IF EXISTS "${process.env.PGDATABASE}"`);
  await c.query(`CREATE DATABASE "${process.env.PGDATABASE}"`);
  await c.end();

  const t = adminClient(process.env.PGDATABASE);
  await t.connect();
  await t.query(fs.readFileSync(path.join(DB_DIR, 'schema.sql'), 'utf8'));
  for (const f of migrationFiles()) {
    if (stopBefore && f.startsWith(stopBefore)) break;
    await t.query(fs.readFileSync(path.join(DB_DIR, 'migrations', f), 'utf8'));
  }
  await t.query(fs.readFileSync(path.join(DB_DIR, 'seed.sql'), 'utf8'));
  await t.end();
}

async function applyMigration(prefix) {
  const f = migrationFiles().find((x) => x.startsWith(prefix));
  if (!f) throw new Error(`No migration file starts with ${prefix}`);
  const t = adminClient(process.env.PGDATABASE);
  await t.connect();
  try {
    await t.query(fs.readFileSync(path.join(DB_DIR, 'migrations', f), 'utf8'));
  } finally {
    await t.end(); // never leave a dangling connection (it would hang the test run)
  }
}

module.exports = { resetDb, applyMigration, db: () => require('../../src/db') };
