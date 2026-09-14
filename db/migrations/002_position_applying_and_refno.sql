-- ============================================================================
-- Migration 002: remove `position_applying`; move reference_no_counters to a
-- per-business-unit/year shape.
--
-- Context (product owner instructions, 2026-09-11):
--   1. "position applying has been removed long ago, anything related to
--      position applying or position should be removed" — drops
--      applications.position_applying.
--   2. "Reference number format ... WCT-<BU>-<YYYY>-<sequence>" — the old
--      global (year-only) reference_no_counters table (created lazily by
--      the previous placeholder implementation of generateReferenceNo) is
--      no longer the right shape now that the counter is scoped per business
--      unit as well as per year. Existing rows in it are just an in-progress
--      global sequence with no continuing meaning under the new format, so
--      this drops and lets it be lazily recreated (empty, per-BU/year) by
--      src/lib/referenceNo.js on first use.
--
-- Safe to run more than once (IF EXISTS / IF EXISTS guards throughout).
-- Run against the live Azure Database for PostgreSQL server via psql, e.g.:
--   psql "host=... dbname=... user=... sslmode=require" -f 002_position_applying_and_refno.sql
-- ============================================================================

ALTER TABLE applications DROP COLUMN IF EXISTS position_applying;

DROP TABLE IF EXISTS reference_no_counters;
-- Recreated automatically, empty, in the new (business_unit, year) shape the
-- next time generateReferenceNo() runs (see src/lib/referenceNo.js) — no
-- action needed here beyond the drop.
