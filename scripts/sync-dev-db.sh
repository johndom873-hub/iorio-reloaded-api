#!/usr/bin/env bash
# Pulls the STAGING Heroku Postgres database down and replaces the local dev database with it.
# Destructive to the LOCAL database only — never writes to Heroku.
#
# Kept from the local database: the users and session rows (logins) and every backtest_* table (backtest sessions and
# their results, jobs, ticker analyses, the Backtesting lab's settings and audit), which exist only locally. Pluto's
# settings follow staging. After the pull the local migrations run, so the schema matches the local code.
#
# Usage: npm run sync-dev-db [-- --database-url=postgres://…/other_db]
#   --database-url targets another local database instead of .env's DATABASE_URL (to try the script on a scratch copy);
#   the dev server is then left running.
#
# Staging is the only environment whose data may be copied to a laptop, and the
# guard below enforces it: production (and the frozen pre-2026-09-21 apps) must
# never be pulled from. The comments further down still say "prod" in places —
# they mean "the source Heroku database" (now staging).
set -euo pipefail

cd "$(dirname "$0")/.."

# npm/non-interactive shells don't source ~/.zshrc, so psql/pg_dump/pg_restore
# (installed via Homebrew libpq or Postgres.app, neither on PATH by default) may be missing.
export PATH="/opt/homebrew/opt/libpq/bin:/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"

HEROKU_APP="iorio-staging-api"
ALLOWED_HEROKU_APP="iorio-staging-api"
if [[ "$HEROKU_APP" != "$ALLOWED_HEROKU_APP" ]]; then
  echo "Refusing to pull from '$HEROKU_APP': only $ALLOWED_HEROKU_APP may be synced to a laptop." >&2
  exit 1
fi
HEROKU_KEY_FILE="$HOME/.config/heroku/iorio-api-key"

if [[ ! -f "$HEROKU_KEY_FILE" ]]; then
  echo "Heroku API key not found at $HEROKU_KEY_FILE" >&2
  exit 1
fi

ENV_DATABASE_URL=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)
if [[ -z "$ENV_DATABASE_URL" ]]; then
  echo "DATABASE_URL not found in .env" >&2
  exit 1
fi

LOCAL_DATABASE_URL="$ENV_DATABASE_URL"
for argument in "$@"; do
  case "$argument" in
    --database-url=*) LOCAL_DATABASE_URL="${argument#--database-url=}" ;;
    *) echo "Unknown argument: $argument" >&2; exit 1 ;;
  esac
done
TARGETS_DEV_DATABASE=0
[[ "$LOCAL_DATABASE_URL" == "$ENV_DATABASE_URL" ]] && TARGETS_DEV_DATABASE=1

LOCAL_DB_NAME=$(basename "$LOCAL_DATABASE_URL")

for bin in psql pg_dump pg_restore; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "$bin not found on PATH" >&2
    exit 1
  fi
done

LOCAL_DATABASE_REACHABLE=0
if psql -Atqc "SELECT 1" "$LOCAL_DATABASE_URL" >/dev/null 2>&1; then
  LOCAL_DATABASE_REACHABLE=1
fi

# The tables kept from the local database: every backtest_* table there is.
BACKTEST_TABLES=""
if [[ "$LOCAL_DATABASE_REACHABLE" -eq 1 ]]; then
  BACKTEST_TABLES=$(psql -Atqc "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'backtest\_%' ORDER BY c.relname" "$LOCAL_DATABASE_URL")
fi

# Stopping the dev server kills its backtest and download jobs: refuse while one is running (a heartbeat in the last 2 minutes).
if [[ -n "$BACKTEST_TABLES" ]] && grep -qx "backtest_jobs" <<<"$BACKTEST_TABLES"; then
  RUNNING_JOBS=$(psql -Atqc "SELECT kind || ' ' || coalesce(symbol, '') FROM backtest_jobs WHERE status = 'running' AND heartbeat_at > now() - interval '2 minutes'" "$LOCAL_DATABASE_URL")
  if [[ -n "$RUNNING_JOBS" ]]; then
    echo "Refusing to sync: these jobs are running and would be stopped with the dev server:" >&2
    echo "$RUNNING_JOBS" | sed 's/^/  /' >&2
    echo "Wait for them to finish or pause them on the Backtesting page, then run the sync again." >&2
    exit 1
  fi
fi

echo "This will DROP and replace the local database '$LOCAL_DB_NAME' with a copy of staging ($HEROKU_APP)."
if [[ -n "$BACKTEST_TABLES" ]]; then
  echo "The local backtest_* tables ($(wc -l <<<"$BACKTEST_TABLES" | tr -d ' ') tables: backtests, jobs, analyses, lab settings) are backed up and restored."
fi
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

DEV_SERVER_PID=""
if [[ "$TARGETS_DEV_DATABASE" -eq 1 ]]; then
  DEV_SERVER_PID=$(lsof -tiTCP:"$DEV_PORT" -sTCP:LISTEN 2>/dev/null || true)
fi
if [[ -n "$DEV_SERVER_PID" ]]; then
  echo "Stopping dev server on port $DEV_PORT (PID $DEV_SERVER_PID)..."
  # tsx watch spawns the real server as a child; killing only the listener orphans
  # that child, which keeps its DB connections open and blocks dropdb.
  pkill -P "$DEV_SERVER_PID" 2>/dev/null || true
  kill $DEV_SERVER_PID
  RESTART_DEV_SERVER=1
  for _ in $(seq 1 20); do
    if ! lsof -tiTCP:"$DEV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

# The backtest tables' rows, backed up to a file that outlives a failed sync (tmp/db-sync-backups/), with each table's
# row count to check the restore against. Deleted only once the restore matches.
BACKTEST_BACKUP_FILE=""
BACKTEST_COUNTS_FILE=""
if [[ -n "$BACKTEST_TABLES" ]]; then
  mkdir -p tmp/db-sync-backups
  BACKUP_STAMP="$LOCAL_DB_NAME-$(date +%Y%m%d-%H%M%S)"
  BACKTEST_BACKUP_FILE="tmp/db-sync-backups/$BACKUP_STAMP-backtest.dump"
  BACKTEST_COUNTS_FILE="tmp/db-sync-backups/$BACKUP_STAMP-backtest-counts.txt"
  echo "Counting the local backtest_* tables' rows..."
  while read -r table; do
    echo "$table $(psql -Atqc "SELECT count(*) FROM public.\"$table\"" "$LOCAL_DATABASE_URL")"
  done <<<"$BACKTEST_TABLES" > "$BACKTEST_COUNTS_FILE"
  echo "Backing up the local backtest_* tables to $BACKTEST_BACKUP_FILE (a few minutes for several GB)..."
  pg_dump "$LOCAL_DATABASE_URL" --format=custom --data-only --no-owner --no-privileges --table='public.backtest_*' -f "$BACKTEST_BACKUP_FILE"
fi

# Keep local login credentials intact across syncs: back up the local users table
# (if present) before dropping the DB, then upsert it back in by id after the pull.
# Note: pg:pull's own --exclude-table-data=public.users can't be used for this —
# it leaves users empty at restore time, which fails FK constraints on other
# tables' rows (shortlist_entries, order_requests) that reference prod's real user
# ids. Pulling users fully, then upserting the local backup over it by id,
# preserves login credentials without deleting any row other tables reference.
USERS_BACKUP_FILE=$(mktemp)
HAVE_USERS_BACKUP=0
if [[ "$LOCAL_DATABASE_REACHABLE" -eq 1 ]] \
  && psql -Atqc "SELECT to_regclass('public.users')" "$LOCAL_DATABASE_URL" 2>/dev/null | grep -q .; then
  echo "Backing up local 'users' table..."
  pg_dump "$LOCAL_DATABASE_URL" --data-only --table=public.users --no-owner --no-privileges -f "$USERS_BACKUP_FILE"
  HAVE_USERS_BACKUP=1
fi

# Keep the local login session alive across syncs too: session has no FK
# dependents (unlike users), so it's simpler -- just restore the local rows
# verbatim after the pull rather than upserting. Pulling with
# --exclude-table-data=public.session skips copying prod's own (unrelated,
# unusable locally) live session rows down at all.
SESSION_BACKUP_FILE=$(mktemp)
HAVE_SESSION_BACKUP=0
if [[ "$LOCAL_DATABASE_REACHABLE" -eq 1 ]] \
  && psql -Atqc "SELECT to_regclass('public.session')" "$LOCAL_DATABASE_URL" 2>/dev/null | grep -q .; then
  echo "Backing up local 'session' table..."
  pg_dump "$LOCAL_DATABASE_URL" --data-only --table=public.session --no-owner --no-privileges -f "$SESSION_BACKUP_FILE"
  HAVE_SESSION_BACKUP=1
fi

echo "Dropping local database '$LOCAL_DB_NAME' if it exists..."
# Safety net for any other leftover connection (orphaned dev-server children etc.).
psql -d postgres -Atqc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$LOCAL_DB_NAME' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
dropdb --if-exists "$LOCAL_DB_NAME"

echo "Pulling staging database from $HEROKU_APP..."
PULL_LOG=$(mktemp)
set +e
# Staging's backtest_* rows are left out: the local ones are restored below.
HEROKU_API_KEY=$(cat "$HEROKU_KEY_FILE") heroku pg:pull DATABASE_URL "$LOCAL_DB_NAME" --app "$HEROKU_APP" \
  --exclude-table-data="public.session;public.backtest_*" 2>&1 | tee "$PULL_LOG"
PULL_EXIT=${PIPESTATUS[0]}
set -e

# heroku pg:pull always exits 1 locally because Heroku's managed _heroku-schema event
# triggers don't exist outside Heroku Postgres — harmless, restore still completes.
UNEXPECTED_ERRORS=$(grep '^pg_restore: error:' "$PULL_LOG" | grep -vc '_heroku' || true)
rm -f "$PULL_LOG"

if [[ "$PULL_EXIT" -ne 0 && "$UNEXPECTED_ERRORS" -gt 0 ]]; then
  echo "pg:pull failed with unexpected errors (see above)." >&2
  rm -f "$USERS_BACKUP_FILE"
  [[ -n "$BACKTEST_BACKUP_FILE" ]] && echo "The local backtest_* rows are kept in $BACKTEST_BACKUP_FILE (counts in $BACKTEST_COUNTS_FILE)." >&2
  exit 1
fi

# Prod runs compiled migrations (dist/src/db/migrations/*.js), so its
# knex_migrations rows are recorded with a .js suffix. Local dev runs the
# TS sources directly via tsx (see knexfile.ts's `extension` setting), so
# without this, every pull leaves knex_migrations pointing at filenames that
# don't exist on disk locally, and knex refuses to run ANY further migration
# ("migration directory is corrupt") until this is fixed by hand.
echo "Normalizing knex_migrations filenames for local dev (prod records .js, local runs .ts)..."
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "UPDATE knex_migrations SET name = regexp_replace(name, '\.js\$', '.ts') WHERE name LIKE '%.js';" >/dev/null

# Staging's schema can be behind the local code (migrations not pushed yet): bring it level before restoring rows that
# were dumped from the local schema. dotenv leaves an already-set DATABASE_URL alone, so knex migrates the target.
echo "Running the local migrations..."
DATABASE_URL="$LOCAL_DATABASE_URL" npm run --silent migrate:latest

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

if [[ -n "$BACKTEST_BACKUP_FILE" ]]; then
  echo "Restoring the local backtest_* rows (several minutes for several GB)..."
  # Emptied first: a migration may have seeded a row (the lab's settings row) that the backup also holds.
  TRUNCATE_LIST=$(sed 's/^\(.*\)$/public."\1"/' <<<"$BACKTEST_TABLES" | paste -sd, -)
  psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE $TRUNCATE_LIST;" >/dev/null
  # Superuser (the local Postgres.app role): foreign keys between the tables are not checked row by row while loading.
  if ! pg_restore --data-only --disable-triggers --single-transaction --no-owner --no-privileges -d "$LOCAL_DATABASE_URL" "$BACKTEST_BACKUP_FILE"; then
    echo "Restoring the backtest_* rows failed; they are kept in $BACKTEST_BACKUP_FILE (counts in $BACKTEST_COUNTS_FILE)." >&2
    exit 1
  fi
  # Sequences past the restored ids (pg_dump restores the matching *_seq values too; this covers any it missed).
  psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
DECLARE
  serial record;
BEGIN
  FOR serial IN
    SELECT c.table_name, c.column_name, pg_get_serial_sequence(format('public.%I', c.table_name), c.column_name) AS sequence_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name LIKE 'backtest\_%'
  LOOP
    IF serial.sequence_name IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, greatest((SELECT coalesce(max(%I), 0) FROM public.%I), (SELECT last_value FROM %s)))', serial.sequence_name, serial.column_name, serial.table_name, serial.sequence_name);
    END IF;
  END LOOP;
END $$;
SQL
  echo "Checking each backtest_* table's row count against the backup..."
  MISMATCHES=""
  while read -r table expected; do
    actual=$(psql -Atqc "SELECT count(*) FROM public.\"$table\"" "$LOCAL_DATABASE_URL")
    [[ "$actual" == "$expected" ]] || MISMATCHES+="  $table: $actual rows, $expected before the sync"$'\n'
  done < "$BACKTEST_COUNTS_FILE"
  if [[ -n "$MISMATCHES" ]]; then
    echo "The restored backtest_* tables differ from before the sync:" >&2
    printf '%s' "$MISMATCHES" >&2
    echo "The local rows are kept in $BACKTEST_BACKUP_FILE (counts in $BACKTEST_COUNTS_FILE)." >&2
    exit 1
  fi
  rm -f "$BACKTEST_BACKUP_FILE" "$BACKTEST_COUNTS_FILE"
fi

if [[ "$HAVE_SESSION_BACKUP" -eq 1 && -s "$SESSION_BACKUP_FILE" ]]; then
  echo "Restoring local 'session' rows (excluded from the pull, so the table is empty at this point)..."
  psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SESSION_BACKUP_FILE" >/dev/null
fi
rm -f "$SESSION_BACKUP_FILE"

echo "Done. Local database '$LOCAL_DB_NAME' now mirrors staging (local 'users', 'session' and backtest_* rows preserved, local migrations applied)."
