'use strict';

// ============================================================================
// Postgres connection pool (Azure Database for PostgreSQL Flexible Server).
//
// Built from discrete PG* env vars rather than a single connection-string URL
// so each part (host/user/password/etc.) can be rotated independently (e.g.
// via Azure App Service's own connection-string / app-settings UI).
//
// Azure Database for PostgreSQL requires TLS. We default to requiring SSL
// (`rejectUnauthorized: false` because Azure's flexible-server chain isn't
// always in Node's default trust store, which is the standard approach for
// `pg` + Azure Postgres) and only allow turning it off via PGSSLMODE=disable,
// which should only ever be used against a local dev database.
// ============================================================================

require('dotenv').config();
const { Pool, types } = require('pg');

// `pg`'s default type parser for a bare `date` column (OID 1082 — no time
// component, e.g. date_of_birth, spouse_date_of_birth, date_available_to_start,
// date_joined, official_last_day, actual_last_day) parses it into a JS Date
// object at UTC midnight. Once that goes through JSON.stringify() in any
// `res.json(...)` response, it turns "1990-05-01" into "1990-05-01T00:00:00.000Z"
// — which is NOT a valid value for an HTML `<input type="date">`, so the
// browser silently renders the field blank rather than erroring. This is
// exactly the bug reported for onboarding's Spouse Date of Birth field: save
// → move to the next section → come back, and the date "disappeared" (it
// didn't — it just no longer matched the yyyy-mm-dd the input requires).
// Registering this parser makes `pg` return the column's own "yyyy-mm-dd"
// wire text unchanged, instead of a Date object, fixing every `date` column
// in the schema at once rather than patching each call site individually.
types.setTypeParser(types.builtins.DATE, (val) => val);

const sslMode = (process.env.PGSSLMODE || 'require').toLowerCase();
const ssl = sslMode === 'disable' ? false : { rejectUnauthorized: false };

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl,
  max: process.env.PGPOOL_MAX ? Number(process.env.PGPOOL_MAX) : 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Idle client errors (e.g. dropped connections) must not crash the process.
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle pg client', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  /**
   * Run `fn` with a single checked-out client, inside a transaction.
   * Commits on resolve, rolls back and rethrows on any error.
   */
  async withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
