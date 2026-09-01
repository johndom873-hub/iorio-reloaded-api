// Populates market_calendar from MarketData.app's free market-status
// endpoint (https://api.marketdata.app/v1/markets/status/ -- requires a
// free-tier API token, no credit card; confirmed live via direct curl
// 2026-09-01). Run this whenever the table's forward coverage is running
// low -- there's no scheduled job for it since NYSE only needs a fresh
// pull every year or so (holidays are published ~2 years out).
//
// Usage:
//   npm run sync-market-calendar
//   npm run sync-market-calendar -- --days=730   (default: 400 days ahead)

import { db } from "../src/db/connection.js";
import { requireEnvironmentVariable } from "../src/config/env.js";

const TRAILING_DAYS = 30;
const DEFAULT_LOOKAHEAD_DAYS = 400;

interface MarketStatusResponse {
  s: string;
  date?: number[];
  status?: (string | null)[];
  errmsg?: string;
}

function parseLookaheadDays(): number {
  const arg = process.argv.find((a) => a.startsWith("--days="));
  return arg ? Number(arg.slice("--days=".length)) : DEFAULT_LOOKAHEAD_DAYS;
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const apiToken = requireEnvironmentVariable("MARKETDATA_API_TOKEN");
  const lookaheadDays = parseLookaheadDays();

  const now = new Date();
  const from = toDateString(new Date(now.getTime() - TRAILING_DAYS * 24 * 60 * 60 * 1000));
  const to = toDateString(new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000));

  const url = `https://api.marketdata.app/v1/markets/status/?from=${from}&to=${to}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`MarketData.app HTTP ${response.status}`);
  const data = (await response.json()) as MarketStatusResponse;
  if (data.s !== "ok") throw new Error(`MarketData.app returned status "${data.s}": ${data.errmsg ?? "no error message"}`);

  const dates = data.date ?? [];
  const statuses = data.status ?? [];
  if (dates.length === 0) throw new Error("MarketData.app returned no dates for the requested range");

  let written = 0;
  for (let i = 0; i < dates.length; i++) {
    const dateValue = dates[i];
    if (dateValue === undefined) continue;
    const calendarDate = toDateString(new Date(dateValue * 1000));
    const isOpen = statuses[i] === "open";
    await db("market_calendar")
      .insert({ calendar_date: calendarDate, is_open: isOpen })
      .onConflict("calendar_date")
      .merge(["is_open"]);
    written++;
  }

  console.log(`market_calendar synced: ${written} day(s) from ${from} to ${to}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
