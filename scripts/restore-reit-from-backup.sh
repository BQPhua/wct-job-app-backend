#!/bin/bash
# =============================================================================
# Put REIT's companies, admin access, offboarding cases and PIC email back,
# exactly as they were in the backup taken before migration 009 (REIT into
# Malls, undone by migration 010). Run it after migration 010.
#
#   sudo bash /opt/wct/backend/scripts/restore-reit-from-backup.sh ~/wct-before-009-2026-10-29.dump
#
# The backup is restored into a temporary database, compared, and the
# temporary database is dropped. Only rows that were REIT in the backup are
# touched; anything created since then is left alone. Safe to run again.
# Local PostgreSQL only (database on this server).
# =============================================================================
set -euo pipefail
DUMP=${1:-}
[ -n "$DUMP" ] && [ -r "$DUMP" ] || { echo "Usage: $0 <backup .dump file>"; exit 1; }
ENV_FILE=${ENV_FILE:-/etc/wct/backend.env}
envval() { { grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
DB=$(envval PGDATABASE)
[ -n "$DB" ] || { echo "PGDATABASE not found in $ENV_FILE"; exit 1; }
TMP=wct_reit_restore_tmp
PSQL=${PSQL:-sudo -u postgres psql -X -q -v ON_ERROR_STOP=1}
PGRESTORE=${PGRESTORE:-sudo -u postgres pg_restore}

echo "Live database: $DB.  Reading the backup $DUMP ..."
$PSQL -d postgres -c "DROP DATABASE IF EXISTS $TMP" -c "CREATE DATABASE $TMP"
trap '$PSQL -d postgres -c "DROP DATABASE IF EXISTS $TMP" >/dev/null 2>&1 || true' EXIT
$PGRESTORE --no-owner --no-privileges -d "$TMP" < "$DUMP" 2>/dev/null || true
$PSQL -d "$TMP" -tAc "SELECT 1 FROM business_units LIMIT 1" >/dev/null || { echo "The backup could not be read."; exit 1; }

# Build the statements from the backup, then run them on the live database.
STMTS=$($PSQL -d "$TMP" -tA <<'SQL'
SELECT format('UPDATE companies SET business_unit = %L WHERE id = %L AND business_unit = %L;', 'REIT', id, 'Mall')
  FROM companies WHERE business_unit = 'REIT';
SELECT format('UPDATE applications SET business_unit = %L WHERE id = %L AND business_unit = %L;', 'REIT', id, 'Mall')
  FROM applications WHERE business_unit = 'REIT';
SELECT format('UPDATE offboarding_cases SET business_unit = %L WHERE id = %L AND business_unit = %L;', 'REIT', id, 'Mall')
  FROM offboarding_cases WHERE business_unit = 'REIT';
-- Admin access: a REIT grant 009 moved goes back; one it dropped (the person
-- also had the same Malls grant) is added again.
SELECT CASE WHEN EXISTS (SELECT 1 FROM admin_grants m WHERE m.business_unit = 'Mall' AND m.admin_user_id = r.admin_user_id
                           AND m.role = r.role AND COALESCE(m.department_id, 0) = COALESCE(r.department_id, 0))
  THEN format('INSERT INTO admin_grants (admin_user_id, role, business_unit, department_id) VALUES (%L, %L, %L, %s) ON CONFLICT DO NOTHING;',
              r.admin_user_id, r.role, 'REIT', COALESCE(r.department_id::text, 'NULL'))
  ELSE format('UPDATE admin_grants SET business_unit = %L WHERE admin_user_id = %L AND role = %L AND COALESCE(department_id, 0) = %s AND business_unit = %L;',
              'REIT', r.admin_user_id, r.role, COALESCE(r.department_id, 0), 'Mall') END
  FROM admin_grants r WHERE r.business_unit = 'REIT';
SELECT format('UPDATE business_units SET pic_email = %L WHERE code = %L;', pic_email, code)
  FROM business_units WHERE code IN ('REIT', 'Mall');
SQL
)

echo "Applying $(printf '%s\n' "$STMTS" | grep -c . || true) change(s) to $DB ..."
printf 'BEGIN;\n%s\nUPDATE business_units SET is_active = true, merged_into = NULL WHERE code = %s;\nCOMMIT;\n' "$STMTS" "'REIT'" | $PSQL -d "$DB"

echo "REIT now:"
$PSQL -d "$DB" -c "SELECT b.code, b.is_active, b.pic_email,
  (SELECT count(*) FROM applications a WHERE a.business_unit = b.code AND a.status <> 'draft') AS applications,
  (SELECT count(*) FROM companies c WHERE c.business_unit = b.code) AS companies,
  (SELECT count(*) FROM admin_grants g WHERE g.business_unit = b.code) AS admin_grants
  FROM business_units b WHERE b.code IN ('REIT', 'Mall') ORDER BY b.code"
echo "Done. REIT admins should sign out and back in."
