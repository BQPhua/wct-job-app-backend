-- ============================================================================
-- Give the backend's database login (PGUSER in /etc/wct/backend.env) full
-- use of every table, sequence and function in the public schema.
--
-- Why: a migration run with a different login (e.g. the server admin or
-- `postgres`) creates tables owned by that login, and the backend then gets
-- "permission denied for table notification_log" (migration 007) or
-- "... business_units" (migration 008).
--
-- Run it AS THE LOGIN THAT RAN THE MIGRATIONS (or a superuser):
--   psql ... -v app_user=<PGUSER> -f db/fix-app-permissions.sql
-- Easiest: sudo bash scripts/fix-db-permissions.sh
--
-- Safe to run any number of times. Changes permissions only, never data.
-- ============================================================================
\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA public TO :"app_user";
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"app_user";

-- Tables, sequences and functions this login creates in future migrations
-- are usable by the backend straight away, so this can't happen again.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO :"app_user";

-- Report: any table the backend still can't read or write.
SELECT c.relname AS "still missing access"
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   AND NOT (has_table_privilege(:'app_user', c.oid, 'SELECT')
        AND has_table_privilege(:'app_user', c.oid, 'INSERT')
        AND has_table_privilege(:'app_user', c.oid, 'UPDATE')
        AND has_table_privilege(:'app_user', c.oid, 'DELETE'));
