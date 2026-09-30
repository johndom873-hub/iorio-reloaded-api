// Keeps market_calendar populated from MarketData.app's free market-status
// endpoint (https://api.marketdata.app/v1/markets/status/, free-tier API token
// in MARKETDATA_API_TOKEN). Runs daily from Heroku Scheduler and can be run by hand.
//
// Usage (dev):
//   npm run sync-market-calendar
//   npm run sync-market-calendar -- --days=730   (default: 400 days ahead)
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/sync-market-calendar.js

import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import { db } from "../src/db/connection.js";
import { requireEnvironmentVariable } from "../src/config/env.js";
import { parseMarketStatus } from "../src/lib/marketStatusParsing.js";
import { runJob } from "../src/lib/runJob.js";

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
  await runJob("market_calendar_sync", async () => {
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

    const { knownDays, unknownDates } = parseMarketStatus(data.date ?? [], data.status ?? [], toDateString(now));

    for (const day of knownDays) {
      await db("market_calendar").insert({ calendar_date: day.calendarDate, is_open: day.isOpen }).onConflict("calendar_date").merge(["is_open"]);
    }
    // No published status yet (a year or more out): drop any row an older sync stored as "closed"
    // so isMarketClosedToday falls back to the weekday check instead of skipping a real trading day.
    if (unknownDates.length > 0) await db("market_calendar").whereIn("calendar_date", unknownDates).del();
    const written = knownDays.length;

    console.log(`market_calendar synced: ${written} day(s) from ${from} to ${to}.`);
    return { details: { daysWritten: written, unknownDays: unknownDates.length, from, to } };
  });
}

runScript("sync-market-calendar", main, () => db.destroy());
