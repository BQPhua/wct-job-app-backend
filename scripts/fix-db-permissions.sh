#!/bin/bash
# =============================================================================
# Fix "permission denied for table ..." in the admin dashboard.
#
# Grants the backend's database login (PGUSER in /etc/wct/backend.env) access
# to every table, including ones a migration created under another login,
# then checks the backend login can really read the new tables.
#
#   sudo bash /opt/wct/backend/scripts/fix-db-permissions.sh [admin_login]
#
# admin_login: the database login you ran the migrations with. Leave it out
# when the database is on this server (it then uses the local `postgres`
# account). psql asks for that login's password; nothing is stored.
# Safe to run more than once. Changes permissions only, never data.
# =============================================================================
set -euo pipefail
ENV_FILE=${ENV_FILE:-/etc/wct/backend.env}
HERE=$(cd "$(dirname "$0")" && pwd)
SQL="$HERE/../db/fix-app-permissions.sql"

# Read only the PG* settings (the env file also holds flow URLs with & in them).
envval() { { grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
APP_USER=$(envval PGUSER); DB=$(envval PGDATABASE); HOST=$(envval PGHOST); PORT=$(envval PGPORT); PORT=${PORT:-5432}
SSLMODE=$(envval PGSSLMODE); SSLMODE=${SSLMODE:-require}
[ -n "$APP_USER" ] && [ -n "$DB" ] || { echo "PGUSER / PGDATABASE not found in $ENV_FILE"; exit 1; }
echo "Database: $DB on ${HOST:-this server}   backend login: $APP_USER"

ADMIN=${1:-}
case "$HOST" in ""|localhost|127.0.0.1|::1) LOCAL=1 ;; *) LOCAL=0 ;; esac
if [ -z "$ADMIN" ] && [ "$LOCAL" = 1 ]; then
  echo "Granting as the local postgres account..."
  sudo -u postgres psql -X -q -d "$DB" -v app_user="$APP_USER" -f "$SQL"
else
  if [ -z "$ADMIN" ]; then read -rp "Database admin login (the one you ran the migrations with): " ADMIN; fi
  echo "Granting as $ADMIN (psql will ask for its password)..."
  env -u PGPASSWORD psql -X -q "host=$HOST port=$PORT dbname=$DB user=$ADMIN sslmode=$SSLMODE" -v app_user="$APP_USER" -f "$SQL"
fi

echo "Checking the backend login can use the new tables..."
PGPASSWORD=$(envval PGPASSWORD) psql -X -q -t "host=${HOST:-localhost} port=$PORT dbname=$DB user=$APP_USER sslmode=$( [ "$LOCAL" = 1 ] && echo prefer || echo "$SSLMODE")" \
  -c "SELECT 'notification_log ok: ' || count(*) FROM notification_log" \
  -c "SELECT 'business_units ok: ' || count(*) FROM business_units"
echo "Done. Refresh the admin dashboard."
