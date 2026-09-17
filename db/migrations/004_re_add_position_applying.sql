-- ============================================================================
-- Migration 004: re-add `applications.position_applying`.
--
-- Context (product owner instruction, 2026-09-17): the "no position field"
-- decision from migration 002 (2026-09-11) is reversed — the job application
-- form's first page now asks candidates which position they are applying
-- for, and it needs to be visible on the preview page, the exported PDF, the
-- admin dashboard, and fed back into the AI Insights prompts.
--
-- Nullable free-text column, same shape as the one migration 002 dropped —
-- deliberately not a foreign key / enum, since the set of open positions
-- changes far more often than a schema migration should.
--
-- Safe to run more than once (IF NOT EXISTS guard).
-- Run against the live Azure Database for PostgreSQL server via psql, e.g.:
--   psql "host=... dbname=... user=... sslmode=require" -f 004_re_add_position_applying.sql
-- ============================================================================

ALTER TABLE applications ADD COLUMN IF NOT EXISTS position_applying text;
