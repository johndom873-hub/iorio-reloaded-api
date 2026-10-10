import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const state = {
    tickerRow: undefined as { tradingview_ticker: string | null; sector?: string | null } | undefined,
    eventRows: [] as { eventType: string; eventDate: string }[],
    macroEventRows: [] as unknown[],
    calls: [] as { table: string; operations: [string, ...unknown[]][] }[],
  };
  const builderFor = (table: string) => {
    const entry = { table, operations: [] as [string, ...unknown[]][] };
    state.calls.push(entry);
    const builder: Record<string, unknown> = {};
    for (const operation of ["where", "andWhere", "whereRaw", "andWhereRaw", "orderBy", "select"]) {
      builder[operation] = (...args: unknown[]) => {
        entry.operations.push([operation, ...args]);
        return builder;
      };
    }
    builder.first = (...args: unknown[]) => {
      entry.operations.push(["first", ...args]);
      return Promise.resolve(state.tickerRow);
    };
    builder.then = (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(table === "ticker_calendar_events" ? state.eventRows : state.macroEventRows).then(resolve, reject);
    return builder;
  };
  const db = Object.assign((table: string) => builderFor(table), { raw: (sql: string) => ({ rawSql: sql }) });
  return { state, db };
});
vi.mock("../db/connection.js", () => ({ db: database.db }));

import {
  fetchCalendarConflictContext,
  fetchMacroEventWarningEvents,
  findCalendarConflict,
  formatMacroEventWarning,
  type CalendarConflictContext,
} from "./calendarConflict.js";

const earningsOn = (eventDate: string) => ({ eventType: "earnings" as const, eventDate });
const exDividendOn = (eventDate: string) => ({ eventType: "ex_dividend" as const, eventDate });

describe("findCalendarConflict", () => {
  it("returns null when there are no events", () => {
    expect(findCalendarConflict({ resolved: true, events: [] }, "covered_call", "2026-10-16")).toBeNull();
  });

  it("flags earnings on or before the expiry for both strategies", () => {
    const context: CalendarConflictContext = { resolved: true, events: [earningsOn("2026-10-10")] };
    expect(findCalendarConflict(context, "covered_call", "2026-10-16")).toEqual(earningsOn("2026-10-10"));
    expect(findCalendarConflict(context, "cash_secured_put", "2026-10-16")).toEqual(earningsOn("2026-10-10"));
  });

  it("counts an event on the expiry date itself as a conflict", () => {
    const context: CalendarConflictContext = { resolved: true, events: [earningsOn("2026-10-16")] };
    expect(findCalendarConflict(context, "cash_secured_put", "2026-10-16")).toEqual(earningsOn("2026-10-16"));
  });

  it("ignores an event the day after the expiry", () => {
    const context: CalendarConflictContext = { resolved: true, events: [earningsOn("2026-10-17"), exDividendOn("2026-10-17")] };
    expect(findCalendarConflict(context, "covered_call", "2026-10-16")).toBeNull();
  });

  it("flags an ex-dividend date only for covered calls", () => {
    const context: CalendarConflictContext = { resolved: true, events: [exDividendOn("2026-10-12")] };
    expect(findCalendarConflict(context, "covered_call", "2026-10-16")).toEqual(exDividendOn("2026-10-12"));
    expect(findCalendarConflict(context, "cash_secured_put", "2026-10-16")).toBeNull();
  });

  it("returns the first conflicting event in list order, skipping an ex-dividend that does not apply to a put", () => {
    const context: CalendarConflictContext = { resolved: true, events: [exDividendOn("2026-10-08"), earningsOn("2026-10-12")] };
    expect(findCalendarConflict(context, "cash_secured_put", "2026-10-16")).toEqual(earningsOn("2026-10-12"));
    expect(findCalendarConflict(context, "covered_call", "2026-10-16")).toEqual(exDividendOn("2026-10-08"));
  });

  it("skips a late event and still finds an earlier-listed-later conflict", () => {
    const context: CalendarConflictContext = { resolved: true, events: [earningsOn("2026-11-01"), earningsOn("2026-10-14")] };
    expect(findCalendarConflict(context, "cash_secured_put", "2026-10-16")).toEqual(earningsOn("2026-10-14"));
  });

  it("does not use the resolved flag to decide (an unresolved ticker simply has no events)", () => {
    expect(findCalendarConflict({ resolved: false, events: [] }, "covered_call", "2026-10-16")).toBeNull();
  });
});

describe("fetchCalendarConflictContext", () => {
  beforeEach(() => {
    database.state.calls.length = 0;
    database.state.tickerRow = { tradingview_ticker: "NASDAQ:AAPL" };
    database.state.eventRows = [];
  });

  it("marks the context resolved when the ticker has a TradingView symbol and returns the stored rows", async () => {
    database.state.eventRows = [earningsOn("2026-10-29"), exDividendOn("2026-11-07")];
    const context = await fetchCalendarConflictContext("ticker-1");
    expect(context).toEqual({ resolved: true, events: [earningsOn("2026-10-29"), exDividendOn("2026-11-07")] });
  });

  it("queries the ticker by id and the events from today (US Eastern) forward", async () => {
    await fetchCalendarConflictContext("ticker-1", new Date("2026-10-08T02:00:00Z")); // 22:00 EDT on 10-07
    const tickerCall = database.state.calls.find((call) => call.table === "tickers")!;
    expect(tickerCall.operations).toContainEqual(["where", { id: "ticker-1" }]);
    const eventsCall = database.state.calls.find((call) => call.table === "ticker_calendar_events")!;
    expect(eventsCall.operations[0]).toEqual(["where", { ticker_id: "ticker-1" }]);
    expect(eventsCall.operations[1]).toEqual(["whereRaw", "event_date >= ?::date", ["2026-10-07"]]);
  });

  it("is unresolved when the ticker has no TradingView symbol, an empty one, or no row at all", async () => {
    database.state.tickerRow = { tradingview_ticker: null };
    expect((await fetchCalendarConflictContext("t")).resolved).toBe(false);
    database.state.tickerRow = { tradingview_ticker: "" };
    expect((await fetchCalendarConflictContext("t")).resolved).toBe(false);
    database.state.tickerRow = undefined;
    expect((await fetchCalendarConflictContext("t")).resolved).toBe(false);
  });

  it("skips both checks for an ETF: resolved, no events, even with stored rows and no TradingView symbol", async () => {
    database.state.tickerRow = { tradingview_ticker: null, sector: "ETF" };
    database.state.eventRows = [earningsOn("2026-10-29"), exDividendOn("2026-10-14")];
    const context = await fetchCalendarConflictContext("ticker-etf");
    expect(context).toEqual({ resolved: true, events: [] });
    expect(findCalendarConflict(context, "covered_call", "2026-10-16")).toBeNull();
    expect(database.state.calls.some((call) => call.table === "ticker_calendar_events")).toBe(false);
  });

  it("reads the sector with the TradingView symbol", async () => {
    await fetchCalendarConflictContext("ticker-1");
    const tickerCall = database.state.calls.find((call) => call.table === "tickers")!;
    expect(tickerCall.operations).toContainEqual(["first", "tradingview_ticker", "sector"]);
  });
});

describe("macro event warning", () => {
  it("fetches the major macro events still ahead and before the expiry's 16:00 ET close, oldest first", async () => {
    database.state.calls.length = 0;
    database.state.macroEventRows = [{ title: "CPI", eventDate: "2026-10-14" }];
    const events = await fetchMacroEventWarningEvents("20261016");
    expect(events).toEqual([{ title: "CPI", eventDate: "2026-10-14" }]);
    const call = database.state.calls.find((entry) => entry.table === "major_macro_events")!;
    expect(call.operations).toContainEqual(["whereRaw", "event_at > CURRENT_TIMESTAMP"]);
    expect(call.operations).toContainEqual(["andWhereRaw", "event_at < ((to_date(?, 'YYYYMMDD') + time '16:00') AT TIME ZONE 'America/New_York')", ["20261016"]]);
    expect(call.operations).toContainEqual(["orderBy", "event_at", "asc"]);
  });

  it("formats nothing for no events", () => {
    expect(formatMacroEventWarning([])).toBeNull();
  });

  it("formats a single event in the singular", () => {
    expect(formatMacroEventWarning([{ title: "CPI", eventDate: "2026-10-14" }])).toBe("1 economic event before expiry: CPI (2026-10-14)");
  });

  it("formats several events in the plural, joined by semicolons", () => {
    expect(
      formatMacroEventWarning([
        { title: "CPI", eventDate: "2026-10-14" },
        { title: "Fed rate decision", eventDate: "2026-10-28" },
      ]),
    ).toBe("2 economic events before expiry: CPI (2026-10-14); Fed rate decision (2026-10-28)");
  });
});
