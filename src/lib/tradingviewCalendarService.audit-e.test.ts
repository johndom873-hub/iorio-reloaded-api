import knexLibrary, { type Knex } from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";

// Audit E (2026-10-07): the calendar capture's moved-date replacement against the real test database, and the earnings
// loaders Signals reads. Only this file's own tickers are touched (the replacement deletes by ticker_id).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true) }));

const { db } = await import("../db/connection.js");
const testDb: Knex = db;
const { upsertEarningsEvents, upsertDividendEvents } = await import("./tradingviewCalendarService.js");
const { loadEarningsDatesNotYetReported, loadNextEarningsDate, loadEarningsDatesForForecastWindow, loadTickerSignalsInputs } = await import("./signalsStore.js");

const createdTickerIds: string[] = [];
let counter = Date.now() % 1_000_000;

async function createTicker(): Promise<{ id: string; symbol: string; tvTicker: string }> {
  const symbol = `AUE${(counter += 1)}`;
  const tvTicker = `NASDAQ:${symbol}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Audit E Co", sector: "Technology", tradingview_ticker: tvTicker }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  return { id: ticker.id, symbol, tvTicker };
}

async function insertEvent(tickerId: string, eventType: "earnings" | "ex_dividend", eventDate: string, eventTime: string | null = null): Promise<void> {
  await testDb("ticker_calendar_events").insert({ ticker_id: tickerId, event_type: eventType, event_date: eventDate, event_time: eventTime, raw: JSON.stringify({ seededBy: "audit-e" }) });
}

async function storedDates(tickerId: string, eventType: "earnings" | "ex_dividend"): Promise<string[]> {
  const rows: { date: string }[] = await testDb("ticker_calendar_events").where({ ticker_id: tickerId, event_type: eventType }).orderBy("event_date").select(testDb.raw("event_date::text as date"));
  return rows.map((row) => row.date);
}

const seconds = (iso: string): number => Date.parse(iso) / 1000;

afterAll(async () => {
  if (createdTickerIds.length > 0) {
    await testDb("ticker_calendar_events").whereIn("ticker_id", createdTickerIds).del();
    await testDb("tickers").whereIn("id", createdTickerIds).del();
  }
  await testDb.destroy();
});

describe("upsertEarningsEvents replaces a moved date (real DB)", () => {
  it("deletes the old future estimate, keeps past rows (API Ninjas history) and both reported dates", async () => {
    const ticker = await createTicker();
    await insertEvent(ticker.id, "earnings", "2026-07-28"); // API Ninjas history, one day off TradingView's recent date
    await insertEvent(ticker.id, "earnings", "2026-11-05", "0"); // the old estimate
    const written = await upsertEarningsEvents(
      [{ tvTicker: ticker.tvTicker, earnings_release_date: seconds("2026-07-29T20:05:00Z"), earnings_release_time: 1, earnings_release_next_date: seconds("2026-10-29T12:00:00Z"), earnings_release_next_time: 0 }],
      new Map([[ticker.tvTicker, ticker.id]]),
      "2026-10-07",
    );
    expect(written).toBe(2);
    expect(await storedDates(ticker.id, "earnings")).toEqual(["2026-07-28", "2026-07-29", "2026-10-29"]);
  });

  it("deletes nothing when TradingView reports no next date", async () => {
    const ticker = await createTicker();
    await insertEvent(ticker.id, "earnings", "2026-11-05", "0");
    await upsertEarningsEvents([{ tvTicker: ticker.tvTicker, earnings_release_date: seconds("2026-07-29T20:05:00Z"), earnings_release_time: 1, earnings_release_next_date: null }], new Map([[ticker.tvTicker, ticker.id]]), "2026-10-07");
    expect(await storedDates(ticker.id, "earnings")).toEqual(["2026-07-29", "2026-11-05"]);
  });

  it("never touches another ticker's rows, nor this ticker's ex-dividend rows", async () => {
    const reported = await createTicker();
    const bystander = await createTicker();
    await insertEvent(bystander.id, "earnings", "2026-11-05");
    await insertEvent(reported.id, "ex_dividend", "2026-11-12");
    await upsertEarningsEvents([{ tvTicker: reported.tvTicker, earnings_release_date: null, earnings_release_next_date: seconds("2026-10-29T12:00:00Z"), earnings_release_next_time: 0 }], new Map([[reported.tvTicker, reported.id]]), "2026-10-07");
    expect(await storedDates(bystander.id, "earnings")).toEqual(["2026-11-05"]);
    expect(await storedDates(reported.id, "ex_dividend")).toEqual(["2026-11-12"]);
  });

  it("keeps today's row when TradingView now reports it as the recent date, and updates its time code to before-open", async () => {
    const ticker = await createTicker();
    await insertEvent(ticker.id, "earnings", "2026-10-07", "0"); // yesterday's capture: next date today, time unknown
    await upsertEarningsEvents(
      [{ tvTicker: ticker.tvTicker, earnings_release_date: seconds("2026-10-07T11:30:00Z"), earnings_release_time: -1, earnings_release_next_date: seconds("2027-01-12T12:00:00Z"), earnings_release_next_time: 0 }],
      new Map([[ticker.tvTicker, ticker.id]]),
      "2026-10-07",
    );
    expect(await storedDates(ticker.id, "earnings")).toEqual(["2026-10-07", "2027-01-12"]);
    const today = await testDb("ticker_calendar_events").where({ ticker_id: ticker.id, event_type: "earnings" }).whereRaw("event_date = '2026-10-07'").first("event_time");
    expect(today.event_time).toBe("-1");
    expect(await loadEarningsDatesNotYetReported(ticker.id, "2026-10-07")).toEqual(["2027-01-12"]);
  });

  it("stores TradingView's report instant as its US Eastern date: a 19:05 EST after-close report is not the next day", async () => {
    // TradingView's recent date is the report instant (e.g. 20:05Z = 16:05 EDT). 19:05 EST on 2026-11-17 is 00:05Z on the 18th:
    // the UTC slice in eventDateIso stores 2026-11-18, next to the 2026-11-17 estimate row, so the ticker ends up with two
    // earnings dates one day apart (the new "Earnings dates" invariant fails for 30 days) and an after-close "today" row on
    // the 18th that the Signals exclusion counts for the rest of that day.
    const ticker = await createTicker();
    await insertEvent(ticker.id, "earnings", "2026-11-17", "1");
    await upsertEarningsEvents(
      [{ tvTicker: ticker.tvTicker, earnings_release_date: seconds("2026-11-18T00:05:00Z"), earnings_release_time: 1, earnings_release_next_date: seconds("2027-02-16T12:00:00Z"), earnings_release_next_time: 0 }],
      new Map([[ticker.tvTicker, ticker.id]]),
      "2026-11-18",
    );
    expect(await storedDates(ticker.id, "earnings")).toEqual(["2026-11-17", "2027-02-16"]);
  });
});

describe("upsertDividendEvents replaces a moved ex-date (real DB)", () => {
  it("deletes the old upcoming ex-date, keeps the past one and both reported dates", async () => {
    const ticker = await createTicker();
    await insertEvent(ticker.id, "ex_dividend", "2026-08-10");
    await insertEvent(ticker.id, "ex_dividend", "2026-11-09");
    await upsertDividendEvents(
      [{ tvTicker: ticker.tvTicker, dividend_ex_date_recent: seconds("2026-08-12T13:30:00Z"), dividend_amount_recent: 0.25, dividend_ex_date_upcoming: seconds("2026-11-12T13:30:00Z"), dividend_amount_upcoming: 0.26 }],
      new Map([[ticker.tvTicker, ticker.id]]),
      "2026-10-07",
    );
    expect(await storedDates(ticker.id, "ex_dividend")).toEqual(["2026-08-10", "2026-08-12", "2026-11-12"]);
  });

  it("deletes nothing when no upcoming ex-date is reported", async () => {
    const ticker = await createTicker();
    await insertEvent(ticker.id, "ex_dividend", "2026-11-09");
    await upsertDividendEvents([{ tvTicker: ticker.tvTicker, dividend_ex_date_recent: seconds("2026-08-12T13:30:00Z"), dividend_amount_recent: 0.25, dividend_ex_date_upcoming: null }], new Map([[ticker.tvTicker, ticker.id]]), "2026-10-07");
    expect(await storedDates(ticker.id, "ex_dividend")).toEqual(["2026-08-12", "2026-11-09"]);
  });
});

describe("loadEarningsDatesNotYetReported (real DB)", () => {
  it("drops only today's before-open row; after-close, unknown (0) and missing times on today count; future and past by date", async () => {
    const cases: [string | null, boolean][] = [["-1", false], ["1", true], ["0", true], [null, true]];
    for (const [time, counts] of cases) {
      const ticker = await createTicker();
      await insertEvent(ticker.id, "earnings", "2026-07-20", "-1");
      await insertEvent(ticker.id, "earnings", "2026-10-07", time);
      await insertEvent(ticker.id, "earnings", "2027-01-12", "-1");
      expect(await loadEarningsDatesNotYetReported(ticker.id, "2026-10-07")).toEqual(counts ? ["2026-10-07", "2027-01-12"] : ["2027-01-12"]);
      expect(await loadEarningsDatesForForecastWindow(ticker.id)).toHaveLength(3);
    }
  });

  it("a before-open row tomorrow still counts today", async () => {
    const ticker = await createTicker();
    await insertEvent(ticker.id, "earnings", "2026-10-08", "-1");
    expect(await loadEarningsDatesNotYetReported(ticker.id, "2026-10-07")).toEqual(["2026-10-08"]);
  });

  it("loadNextEarningsDate (Pluto's next_earnings) agrees with the exclusion on a before-open report day", async () => {
    // The exclusion no longer counts today's before-open report, but loadNextEarningsDate still returns today: Pluto's prompt
    // is told "if anything you are offered would still be open on next_earnings, do not choose it", so on a before-open
    // report day it is told to refuse every candidate the exclusion has just let through.
    const ticker = await createTicker();
    await insertEvent(ticker.id, "earnings", "2026-10-07", "-1");
    await insertEvent(ticker.id, "earnings", "2027-01-12", "0");
    const notYetReported = await loadEarningsDatesNotYetReported(ticker.id, "2026-10-07");
    expect(await loadNextEarningsDate(ticker.id, "2026-10-07")).toBe([...notYetReported].sort()[0]);
  });

  it("loadTickerSignalsInputs feeds the exclusion the not-yet-reported dates with today's Eastern date (19:30 ET = 23:30Z still today)", async () => {
    const ticker = await createTicker();
    await insertEvent(ticker.id, "earnings", "2026-10-07", "-1");
    await insertEvent(ticker.id, "earnings", "2027-01-12", "0");
    const inputs = await loadTickerSignalsInputs({ tickerId: ticker.id, symbol: ticker.symbol, companyName: null, sector: null }, new Date("2026-10-07T23:30:00Z"));
    expect(inputs.todayEasternIso).toBe("2026-10-07");
    expect(inputs.earningsDatesIso).toEqual(["2027-01-12"]);
    expect(inputs.earningsCalendarResolved).toBe(true);
  });
});
