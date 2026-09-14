'use strict';

// ============================================================================
// Reference number generation (spec §6.1, §9.1).
//
// FORMAT CONFIRMED by the product owner (2026-09-11): `WCT-<BU>-<YYYY>-<seq>`,
// e.g. `WCT-EC-2026-000123`, `WCT-LAND-2026-000001`, `WCT-MALL-2026-000001`.
// This supersedes the earlier placeholder global-sequence format
// (`WCT-<YYYY>-<seq>`, no BU segment) that lived in this file before that
// instruction arrived — every call site goes through `generateReferenceNo`,
// so this was a one-function change plus a counter-table migration (see
// db/migrations/002_position_applying_and_refno.sql, which drops the old
// global `reference_no_counters` table so it's recreated with the new
// per-BU/year shape below).
//
// Concurrency: uses a dedicated counter table keyed by (business_unit, year),
// incremented inside the same transaction that inserts the new application
// row, so two concurrent `create draft` calls — even for the same BU in the
// same year — can never race onto the same number. Falls back to lazily
// creating that counter table if it doesn't exist yet (first call after a
// fresh deploy).
// ============================================================================

const CURRENT_YEAR_FALLBACK = () => new Date().getUTCFullYear();

// Short, URL-/filename-safe codes for each business unit, used as the <BU>
// segment. Chosen to be unambiguous and human-readable in exports/emails.
const BU_CODES = {
  'E&C': 'EC',
  Land: 'LAND',
  Mall: 'MALL',
};

function buCodeFor(businessUnit) {
  return BU_CODES[businessUnit] || String(businessUnit || 'GEN').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Allocate and format the next reference number, using `client` (a checked-
 * out pg client, expected to already be inside a transaction alongside the
 * INSERT that will consume this number).
 *
 * @param {import('pg').PoolClient} client
 * @param {string} businessUnit - 'E&C' | 'Land' | 'Mall'
 * @returns {Promise<string>}
 */
async function generateReferenceNo(client, businessUnit) {
  const year = CURRENT_YEAR_FALLBACK();
  const buCode = buCodeFor(businessUnit);

  await client.query(`
    CREATE TABLE IF NOT EXISTS reference_no_counters (
      business_unit text NOT NULL,
      year          integer NOT NULL,
      value         integer NOT NULL DEFAULT 0,
      PRIMARY KEY (business_unit, year)
    )
  `);

  const { rows } = await client.query(
    `INSERT INTO reference_no_counters (business_unit, year, value)
     VALUES ($1, $2, 1)
     ON CONFLICT (business_unit, year) DO UPDATE SET value = reference_no_counters.value + 1
     RETURNING value`,
    [businessUnit, year]
  );

  const seq = rows[0].value;
  const seqStr = String(seq).padStart(6, '0');
  return `WCT-${buCode}-${year}-${seqStr}`;
}

module.exports = { generateReferenceNo, buCodeFor };
