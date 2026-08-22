#!/usr/bin/env bash
# Pulls the prod Heroku Postgres database down and replaces the local dev database with it.
# Destructive to the LOCAL database only — never writes to prod.
set -euo pipefail

cd "$(dirname "$0")/.."

# npm/non-interactive shells don't source ~/.zshrc, so psql/pg_dump/pg_restore
# (installed via Homebrew libpq or Postgres.app, neither on PATH by default) may be missing.
export PATH="/opt/homebrew/opt/libpq/bin:/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"

HEROKU_APP="iorio-reloaded-api"
HEROKU_KEY_FILE="$HOME/.config/heroku/iorio-api-key"

if [[ ! -f "$HEROKU_KEY_FILE" ]]; then
  echo "Heroku API key not found at $HEROKU_KEY_FILE" >&2
  exit 1
fi

LOCAL_DATABASE_URL=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)
if [[ -z "$LOCAL_DATABASE_URL" ]]; then
  echo "DATABASE_URL not found in .env" >&2
  exit 1
fi

LOCAL_DB_NAME=$(basename "$LOCAL_DATABASE_URL")

for bin in psql pg_dump pg_restore; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "$bin not found on PATH" >&2
    exit 1
  fi
done

echo "This will DROP and replace the local database '$LOCAL_DB_NAME' with a copy of prod ($HEROKU_APP)."
read -r -p "Continue? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted."
  exit 1
fi

DEV_PORT=$(grep -m1 '^PORT=' .env | cut -d= -f2-)
DEV_PORT="${DEV_PORT:-3030}"
RESTART_DEV_SERVER=0

restart_dev_server() {
  if [[ "$RESTART_DEV_SERVER" -eq 1 ]]; then
    echo "Restarting dev server..."
    mkdir -p tmp
    nohup npm run dev > tmp/dev-server.log 2>&1 &
    disown
    echo "Dev server restarted in background (PID $!, logging to tmp/dev-server.log)."
  fi
}
trap restart_dev_server EXIT

DEV_SERVER_PID=$(lsof -tiTCP:"$DEV_PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$DEV_SERVER_PID" ]]; then
  echo "Stopping dev server on port $DEV_PORT (PID $DEV_SERVER_PID)..."
  kill $DEV_SERVER_PID
  RESTART_DEV_SERVER=1
  for _ in $(seq 1 20); do
    if ! lsof -tiTCP:"$DEV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

# Keep local login credentials intact across syncs: back up the local users table
# (if present) before dropping the DB, then upsert it back in by id after the pull.
# Note: pg:pull's own --exclude-table-data=public.users can't be used for this —
# it leaves users empty at restore time, which fails FK constraints on other
# tables' rows (shortlist_entries, trade_alerts) that reference prod's real user
# ids. Pulling users fully, then upserting the local backup over it by id,
# preserves login credentials without deleting any row other tables reference.
USERS_BACKUP_FILE=$(mktemp)
HAVE_USERS_BACKUP=0
if psql -Atqc "SELECT 1" "$LOCAL_DATABASE_URL" >/dev/null 2>&1 \
  && psql -Atqc "SELECT to_regclass('public.users')" "$LOCAL_DATABASE_URL" 2>/dev/null | grep -q .; then
  echo "Backing up local 'users' table..."
  pg_dump "$LOCAL_DATABASE_URL" --data-only --table=public.users --no-owner --no-privileges -f "$USERS_BACKUP_FILE"
  HAVE_USERS_BACKUP=1
fi

echo "Dropping local database '$LOCAL_DB_NAME' if it exists..."
dropdb --if-exists "$LOCAL_DB_NAME"

echo "Pulling prod database from $HEROKU_APP..."
PULL_LOG=$(mktemp)
set +e
HEROKU_API_KEY=$(cat "$HEROKU_KEY_FILE") heroku pg:pull DATABASE_URL "$LOCAL_DB_NAME" --app "$HEROKU_APP" 2>&1 | tee "$PULL_LOG"
PULL_EXIT=${PIPESTATUS[0]}
set -e

# heroku pg:pull always exits 1 locally because Heroku's managed _heroku-schema event
# triggers don't exist outside Heroku Postgres — harmless, restore still completes.
UNEXPECTED_ERRORS=$(grep '^pg_restore: error:' "$PULL_LOG" | grep -vc '_heroku' || true)
rm -f "$PULL_LOG"

if [[ "$PULL_EXIT" -ne 0 && "$UNEXPECTED_ERRORS" -gt 0 ]]; then
  echo "pg:pull failed with unexpected errors (see above)." >&2
  rm -f "$USERS_BACKUP_FILE"
  exit 1
fi

if [[ "$HAVE_USERS_BACKUP" -eq 1 && -s "$USERS_BACKUP_FILE" ]]; then
  echo "Restoring local 'users' rows over prod's (upsert by id — doesn't delete any row)..."
  UPSERT_SQL=$(mktemp)
  {
    echo "BEGIN;"
    echo "CREATE TEMP TABLE users_local_backup (LIKE public.users INCLUDING ALL);"
    sed 's/^COPY public\.users /COPY users_local_backup /' "$USERS_BACKUP_FILE"
    cat <<'SQL'
-- Conflict target is lower(username), not id: a local-only user row created
-- before ever syncing can have a different id than the same-username prod row.
-- Matching on username and leaving id out of the SET list means an existing
-- prod row keeps its id (so other tables' FK references stay valid) while its
-- content columns get overwritten with the local values.
DO $$
DECLARE
  update_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name) || ' = EXCLUDED.' || quote_ident(column_name), ', ')
  INTO update_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'users' AND column_name <> 'id';

  EXECUTE format(
    'INSERT INTO public.users SELECT * FROM users_local_backup ON CONFLICT (lower(username)) DO UPDATE SET %s',
    update_cols
  );
END $$;
COMMIT;
SQL
  } > "$UPSERT_SQL"
  psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$UPSERT_SQL" >/dev/null
  rm -f "$UPSERT_SQL"
fi
rm -f "$USERS_BACKUP_FILE"

echo "Done. Local database '$LOCAL_DB_NAME' now mirrors prod (local 'users' rows preserved)."
