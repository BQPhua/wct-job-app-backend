-- ============================================================================
-- Migration 003: support Google + Microsoft (Entra) OAuth sign-in/sign-up
-- for candidates, alongside the existing email+password flow.
--
-- Context (product owner instruction, 2026-09-11): "for microsoft and google
-- login and sign up, you can check app registration, redirect URL, while for
-- google login, you can check google cloud console credentials and other
-- stuff." This migration is the schema half of that work (see
-- src/lib/oauthVerify.js, src/routes/auth.js, src/routes/admin.js for the
-- verification + session-issuance code).
--
-- `users.password_hash` was NOT NULL because every candidate account used to
-- go through /api/auth/register. An OAuth-only candidate (signed up via
-- Google or Microsoft, never set a password) has no password hash at all —
-- so that column becomes nullable, and `auth_provider`/`auth_subject`
-- record which identity provider created/owns the row and that provider's
-- stable subject id (Google `sub` / Microsoft `oid`), mirroring the existing
-- `admin_users.auth_user_id` pattern already used for admin accounts.
--
-- Safe to run more than once (IF EXISTS / IF NOT EXISTS guards throughout).
-- Run against the live Azure Database for PostgreSQL server via psql, e.g.:
--   psql "host=... dbname=... user=... sslmode=require" -f 003_oauth_login.sql
-- ============================================================================

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'password';
-- One of: 'password' | 'google' | 'microsoft'. Existing rows all correctly
-- default to 'password' (they could only have been created via /register).

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_subject text;
-- The provider's stable subject id for this account (Google ID token `sub`,
-- Microsoft ID token `oid`) — NOT the same value across providers, so it's
-- only ever compared against rows with a matching auth_provider. Nullable:
-- always NULL for 'password' rows.

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_provider_subject
  ON users (auth_provider, auth_subject)
  WHERE auth_subject IS NOT NULL;
-- Prevents two different `users` rows from ever being linked to the same
-- (provider, subject) pair — defense in depth alongside the email-based
-- lookup/link logic in src/routes/auth.js.
