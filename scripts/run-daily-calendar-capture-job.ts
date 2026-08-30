// Scheduled job: captures earnings dates, ex-dividend dates (per shortlisted/
// open-position ticker), and the US macro economic calendar, all sourced
// from TradingView's public endpoints — see src/lib/tradingviewCalendarService.ts
// for the endpoint details and why TradingView instead of IBKR/MarketWatch
// (PROGRESS.md, 2026-08-30). No IBKR Gateway involved, so unlike the other
// daily jobs this doesn't need market hours or a Gateway connection.
//
// Usage (dev):
//   npm run job:daily-calendar-capture
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-daily-calendar-capture-job.js

import { db } from "../src/db/connection.js";
import { runJob } from "../src/lib/runJob.js";
import {
  fetchDividendEvents,
  fetchEarningsEvents,
  fetchEconomicCalendarEvents,
  resolveTradingViewTicker,
} from "../src/lib/tradingviewCalendarService.js";

interface TickerRow {
  id: string;
  symbol: string;
}

const LOOKAHEAD_DAYS = 90;

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function main(): Promise<void> {
  await runJob("daily_calendar_capture", async () => {
    const tickers: TickerRow[] = await db.raw(
      `
      SELECT DISTINCT t.id, t.symbol
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
    const unresolved: string[] = [];
    for (const ticker of tickers) {
      const tvTicker = await resolveTradingViewTicker(ticker.id, ticker.symbol);
      if (tvTicker) tvTickerByTickerId.set(ticker.id, tvTicker);
      else unresolved.push(ticker.symbol);
    }

    const tickerIdByTvTicker = new Map(Array.from(tvTickerByTickerId.entries()).map(([id, tv]) => [tv, id]));
    const tvTickers = Array.from(tvTickerByTickerId.values());

    let earningsWritten = 0;
    let dividendsWritten = 0;
    try {
      const earningsRows = await fetchEarningsEvents(tvTickers, fromSec, toSec);
      for (const row of earningsRows) {
        const tickerId = tickerIdByTvTicker.get(row.tvTicker as string);
        if (!tickerId) continue;
        for (const dateField of ["earnings_release_date", "earnings_release_next_date"] as const) {
          const raw = row[dateField];
          if (raw === null || raw === undefined) continue;
          const eventDate = new Date((raw as number) * 1000).toISOString().slice(0, 10);
          const eventTime = row[dateField === "earnings_release_date" ? "earnings_release_time" : "earnings_release_next_time"];
          await db("ticker_calendar_events")
            .insert({
              ticker_id: tickerId,
              event_type: "earnings",
              event_date: eventDate,
              event_time: eventTime === null || eventTime === undefined ? null : String(eventTime),
              raw: JSON.stringify(row),
            })
            .onConflict(["ticker_id", "event_type", "event_date"])
            .merge(["event_time", "raw", "captured_at"]);
          earningsWritten++;
        }
      }
    } catch (error) {
      console.error("daily_calendar_capture: earnings fetch failed", error);
    }

    try {
      const dividendRows = await fetchDividendEvents(tvTickers, fromSec, toSec);
      for (const row of dividendRows) {
        const tickerId = tickerIdByTvTicker.get(row.tvTicker as string);
        if (!tickerId) continue;
        for (const [dateField, amountField] of [
          ["dividend_ex_date_recent", "dividend_amount_recent"],
          ["dividend_ex_date_upcoming", "dividend_amount_upcoming"],
        ] as const) {
          const raw = row[dateField];
          if (raw === null || raw === undefined) continue;
          const eventDate = new Date((raw as number) * 1000).toISOString().slice(0, 10);
          const amount = row[amountField];
          await db("ticker_calendar_events")
            .insert({
              ticker_id: tickerId,
              event_type: "ex_dividend",
              event_date: eventDate,
              amount: amount === null || amount === undefined ? null : Number(amount),
              raw: JSON.stringify(row),
            })
            .onConflict(["ticker_id", "event_type", "event_date"])
            .merge(["amount", "raw", "captured_at"]);
          dividendsWritten++;
        }
      }
    } catch (error) {
      console.error("daily_calendar_capture: dividends fetch failed", error);
    }

    let economicWritten = 0;
    try {
      const fromIso = now.toISOString();
      const toIso = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const events = await fetchEconomicCalendarEvents(fromIso, toIso);
      for (const event of events) {
        await db("economic_calendar_events")
          .insert({
            external_id: event.id,
            title: event.title,
            country: event.country,
            category: event.category ?? null,
            importance: event.importance ?? null,
            actual: event.actual ?? null,
            forecast: event.forecast ?? null,
            previous: event.previous ?? null,
            event_at: event.date,
            raw: JSON.stringify(event),
          })
          .onConflict("external_id")
          .merge(["actual", "forecast", "previous", "raw", "captured_at"]);
        economicWritten++;
      }
    } catch (error) {
      console.error("daily_calendar_capture: economic calendar fetch failed", error);
    }

    console.log(
      `Calendar capture: ${tvTickers.length}/${tickers.length} ticker(s) resolved (${unresolved.length} unresolved), ` +
        `${earningsWritten} earnings row(s), ${dividendsWritten} dividend row(s), ${economicWritten} economic event(s).`,
    );

    return {
      details: {
        tickerCount: tickers.length,
        resolvedCount: tvTickers.length,
        unresolvedSymbols: unresolved,
        earningsWritten,
        dividendsWritten,
        economicWritten,
      },
    };
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
