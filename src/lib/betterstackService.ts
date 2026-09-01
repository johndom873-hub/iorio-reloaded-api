import { requireEnvironmentVariable } from "../config/env.js";

// Better Stack (Logtail add-on) SQL API -- queries the 8-day log archive
// that backs each Heroku app's log drain. Ported from menaris-admin-api's
// betterstack-service.js (used by "Jack"), adapted to this codebase's
// plain-fetch convention and to cover TWO separate Heroku apps instead of
// one: iorio-reloaded-api and iorio-reloaded-app landed in two separate
// Better Stack teams/workspaces when provisioned 2026-09-01 (different
// team ids, t591705 vs t591706), not one shared account as first assumed --
// so each app has its own full set of SQL credentials, not just its own
// source table name. Never Heroku's own log-session API: it caps at 1500
// lines regardless of the requested window, which can silently under-cover
// a busy period.
export type LogSourceApp = "api" | "app";

interface BetterStackCredentials {
  host: string;
  username: string;
  password: string;
  sourceTable: string;
}

function credentialsFor(sourceApp: LogSourceApp): BetterStackCredentials {
  if (sourceApp === "api") {
    return {
      host: requireEnvironmentVariable("BETTERSTACK_SQL_HOST"),
      username: requireEnvironmentVariable("BETTERSTACK_SQL_USERNAME"),
      password: requireEnvironmentVariable("BETTERSTACK_SQL_PASSWORD"),
      sourceTable: requireEnvironmentVariable("BETTERSTACK_SOURCE_TABLE"),
    };
  }
  return {
    host: requireEnvironmentVariable("BETTERSTACK_APP_SQL_HOST"),
    username: requireEnvironmentVariable("BETTERSTACK_APP_SQL_USERNAME"),
    password: requireEnvironmentVariable("BETTERSTACK_APP_SQL_PASSWORD"),
    sourceTable: requireEnvironmentVariable("BETTERSTACK_APP_SOURCE_TABLE"),
  };
}

interface BetterStackRow {
  dt: string;
  raw: string;
}

async function runQuery(credentials: BetterStackCredentials, sql: string): Promise<BetterStackRow[]> {
  const response = await fetch(`https://${credentials.host}?output_format_pretty_row_numbers=0`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
      "Content-Type": "text/plain",
    },
    body: sql,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Better Stack SQL API HTTP ${response.status}`);
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BetterStackRow);
}

// Reconstructs the string ourselves from a parsed Date rather than
// interpolating the caller's input verbatim -- input here ultimately comes
// from LLM tool-call arguments, so this is what keeps it out of the SQL
// body instead of just being a formatting nicety.
function toSqlDateTime(input: string): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date/time: ${input}`);
  return d.toISOString().slice(0, 23).replace("T", " ");
}

function rowsToLines(rows: BetterStackRow[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    let message = row.raw;
    try {
      message = (JSON.parse(row.raw) as { message?: string }).message ?? row.raw;
    } catch {
      // raw wasn't JSON -- fall back to it verbatim.
    }
    const key = `${row.dt}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${row.dt} ${message}`);
  }
  return lines.join("\n");
}

export interface FetchLogsOptions {
  sourceApp: LogSourceApp;
  minutes?: number;
  startTime?: string;
  endTime?: string;
}

// Cold storage (s3Cluster) lags roughly an hour behind live and covers the
// full 8-day retention; hot storage (remote) has no such lag but only
// covers a recent window. Both are unioned and deduped by (dt, message)
// since their windows overlap.
//
// Pass either `minutes` (relative window ending now) or `startTime`+
// `endTime` (ISO 8601, absolute range) to investigate a specific past
// incident instead of "the last N minutes".
export async function fetchLogsFromBetterStack({ sourceApp, minutes, startTime, endTime }: FetchLogsOptions): Promise<string> {
  const credentials = credentialsFor(sourceApp);
  const condition =
    startTime && endTime
      ? `dt BETWEEN toDateTime64('${toSqlDateTime(startTime)}', 3, 'UTC') AND toDateTime64('${toSqlDateTime(endTime)}', 3, 'UTC')`
      : `dt >= now() - INTERVAL ${Math.ceil(minutes ?? 30)} MINUTE`;
  // ORDER BY/LIMIT after UNION ALL only binds to the last SELECT, not the
  // combined result -- must wrap in an outer query to sort/limit across
  // both hot and cold storage together. Ordered DESC (most recent first)
  // since an 8-day window can hold tens of thousands of rows -- an ASC
  // order would cap at the OLDEST 5000 instead of the ones actually relevant.
  const sql = `
    SELECT dt, raw FROM (
      SELECT dt, raw FROM remote(${credentials.sourceTable}_logs)
      WHERE ${condition}
      UNION ALL
      SELECT dt, raw FROM s3Cluster(primary, ${credentials.sourceTable}_s3)
      WHERE _row_type = 1 AND ${condition}
    )
    ORDER BY dt DESC
    LIMIT 5000
    FORMAT JSONEachRow
  `;
  const rows = await runQuery(credentials, sql);
  rows.reverse();
  return rowsToLines(rows);
}
