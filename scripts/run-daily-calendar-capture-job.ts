// Scheduled job: captures earnings and ex-dividend dates (per shortlisted/
// open-position ticker) from TradingView's public endpoints -- see
// src/lib/tradingviewCalendarService.ts for the endpoint details and why
// TradingView instead of IBKR/MarketWatch (PROGRESS.md, 2026-08-30) -- and the
// major US macro events (Fed rate decision, CPI, GDP, US federal elections)
// from FRED, the Federal Reserve's FOMC calendar and the election date rule
// (src/lib/macroEventCalendar.ts). No IBKR Gateway involved, so unlike the
// other daily jobs this doesn't need market hours or a Gateway connection.
//
// Usage (dev):
//   npm run job:daily-calendar-capture
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-daily-calendar-capture-job.js

import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import { db } from "../src/db/connection.js";
import { buildCalendarCaptureFailureMessage, selectAlertWorthyUnresolved, type CalendarFetchFailure, type UnresolvedTicker } from "../src/lib/calendarCaptureOutcome.js";
import { runJob } from "../src/lib/runJob.js";
import { captureMajorMacroEvents, reportMajorMacroEventHorizon } from "../src/lib/macroEventCalendar.js";
import {
  fetchDividendEvents,
  fetchEarningsEvents,
  resolveTradingViewTickerDetailed,
  upsertDividendEvents,
  upsertEarningsEvents,
} from "../src/lib/tradingviewCalendarService.js";

interface TickerRow {
  id: string;
  symbol: string;
  sector: string | null;
}

const LOOKAHEAD_DAYS = 90;

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function main(): Promise<void> {
  await runJob("daily_calendar_capture", async () => {
    const tickers: TickerRow[] = await db.raw(
      `
      SELECT DISTINCT t.id, t.symbol, t.sector
      FROM tickers t
      WHERE EXISTS (SELECT 1 FROM shortlist_entries se WHERE se.ticker_id = t.id AND se.removed_at IS NULL)
         OR EXISTS (SELECT 1 FROM positions p WHERE p.ticker_id = t.id AND p.status = 'open')
      ORDER BY t.symbol
      `,
    ).then((result) => result.rows);

    const now = new Date();
    const fromSec = toUnixSeconds(now) - 30 * 24 * 60 * 60; // small trailing window, catches "recent" earnings/div fields
    const toSec = toUnixSeconds(now) + LOOKAHEAD_DAYS * 24 * 60 * 60;

    // Resolve TradingView tickers (cached after first run — see
    // resolveTradingViewTicker) and split out any ticker TradingView
    // couldn't match, so one bad symbol doesn't drop the whole batch.
    const tvTickerByTickerId = new Map<string, string>();
    const unresolvedTickers: UnresolvedTicker[] = [];
    for (const ticker of tickers) {
      const resolution = await resolveTradingViewTickerDetailed(ticker.id, ticker.symbol);
      if ("reason" in resolution) unresolvedTickers.push({ symbol: ticker.symbol, sector: ticker.sector, reason: resolution.reason });
      else tvTickerByTickerId.set(ticker.id, resolution.tvTicker);
    }
    const unresolved = unresolvedTickers.map((ticker) => ticker.symbol);

    const tickerIdByTvTicker = new Map(Array.from(tvTickerByTickerId.entries()).map(([id, tv]) => [tv, id]));
    const tvTickers = Array.from(tvTickerByTickerId.values());

    const fetchFailures: CalendarFetchFailure[] = [];
    const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
    let earningsWritten = 0;
    let dividendsWritten = 0;
    try {
      const earningsRows = await fetchEarningsEvents(tvTickers, fromSec, toSec);
      earningsWritten = await upsertEarningsEvents(earningsRows, tickerIdByTvTicker);
    } catch (error) {
      console.error("daily_calendar_capture: earnings fetch failed", error);
      fetchFailures.push({ source: "earnings", message: describeError(error) });
    }

    try {
      const dividendRows = await fetchDividendEvents(tvTickers, fromSec, toSec);
      dividendsWritten = await upsertDividendEvents(dividendRows, tickerIdByTvTicker);
    } catch (error) {
      console.error("daily_calendar_capture: dividends fetch failed", error);
      fetchFailures.push({ source: "dividends", message: describeError(error) });
    }

    const macroEvents = await captureMajorMacroEvents(now);
    for (const failure of macroEvents.failures) fetchFailures.push({ source: `major macro events, ${failure.source}`, message: failure.message });
    await reportMajorMacroEventHorizon(macroEvents);
    const macroEventsWritten = Object.values(macroEvents.writtenBySource).reduce((total, count) => total + count, 0);

    console.log(
      `Calendar capture: ${tvTickers.length}/${tickers.length} ticker(s) resolved (${unresolved.length} unresolved), ` +
        `${earningsWritten} earnings row(s), ${dividendsWritten} dividend row(s), ${macroEventsWritten} major macro event(s).`,
    );

    return {
      details: {
        tickerCount: tickers.length,
        resolvedCount: tvTickers.length,
        unresolvedSymbols: unresolved,
        earningsWritten,
        dividendsWritten,
        macroEventsWrittenBySource: macroEvents.writtenBySource,
        macroEventHorizonShortfalls: macroEvents.horizonShortfalls,
        fetchFailures,
      },
      // Recorded as a failure (runJob alerts) instead of a success with stale rows: the earnings dates gate trades.
      failureMessage: buildCalendarCaptureFailureMessage({ tickerCount: tickers.length, fetchFailures, unresolvedSymbols: selectAlertWorthyUnresolved(unresolvedTickers) }),
    };
  });
}

runScript("run-daily-calendar-capture-job", main, () => db.destroy());
