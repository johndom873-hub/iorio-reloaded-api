#!/usr/bin/env bash
# Replaces the local screener_universe (the Screener tab's rows) with staging's. Reads staging only; writes only that one
# local table, in one transaction, so a failed load leaves the local rows as they were. The dev server keeps running.
#
# Usage: npm run sync-screener
set -euo pipefail

cd "$(dirname "$0")/.."

# npm/non-interactive shells don't source ~/.zshrc, so psql/pg_dump may be missing from PATH.
export PATH="/opt/homebrew/opt/libpq/bin:/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"

# Staging is the only environment whose data may be copied to a laptop (as in sync-dev-db.sh).
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

LOCAL_DATABASE_URL=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)
if [[ -z "$LOCAL_DATABASE_URL" ]]; then
  echo "DATABASE_URL not found in .env" >&2
  exit 1
fi

for bin in psql pg_dump heroku; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "$bin not found on PATH" >&2
    exit 1
  fi
done

LOAD_FILE=$(mktemp)
trap 'rm -f "$LOAD_FILE"' EXIT

echo "Reading staging's screener_universe ($HEROKU_APP)..."
STAGING_DATABASE_URL=$(HEROKU_API_KEY=$(cat "$HEROKU_KEY_FILE") heroku config:get DATABASE_URL --app "$HEROKU_APP")
if [[ -z "$STAGING_DATABASE_URL" ]]; then
  echo "Could not read $HEROKU_APP's DATABASE_URL." >&2
  exit 1
fi
{
  echo "TRUNCATE public.screener_universe;"
  pg_dump "$STAGING_DATABASE_URL" --data-only --no-owner --no-privileges --table=public.screener_universe
} > "$LOAD_FILE"

echo "Replacing the local screener_universe..."
if ! psql "$LOCAL_DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -q -f "$LOAD_FILE" >/dev/null; then
  echo "Loading failed; the local rows are unchanged. If a column is missing, run the local migrations (npm run migrate:latest)." >&2
  exit 1
fi

SUMMARY=$(psql "$LOCAL_DATABASE_URL" -Atc "SELECT count(*) || ' rows, last refreshed ' || coalesce(to_char(max(last_refreshed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC', 'never') FROM public.screener_universe")
echo "Done: the local screener_universe mirrors staging ($SUMMARY)."
