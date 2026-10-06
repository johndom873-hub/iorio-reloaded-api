import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RecordedDatabaseCall {
  table: string;
  operation: "first" | "update" | "insert";
  where?: unknown;
  columns?: unknown;
  values?: unknown;
  conflictColumns?: unknown;
  mergeColumns?: unknown;
}

const recordedDatabaseCalls: RecordedDatabaseCall[] = [];
const storedTradingViewTickerByTickerId = new Map<string, string | null>();

vi.mock("../db/connection.js", () => ({
  db: (table: string) => {
    let whereClause: unknown;
    const builder = {
      where(clause: unknown) {
        whereClause = clause;
        return builder;
      },
      async first(...columns: unknown[]) {
        recordedDatabaseCalls.push({ table, operation: "first", where: whereClause, columns });
        const tickerId = (whereClause as { id: string }).id;
        return storedTradingViewTickerByTickerId.has(tickerId) ? { tradingview_ticker: storedTradingViewTickerByTickerId.get(tickerId) } : undefined;
      },
      async update(values: unknown) {
        recordedDatabaseCalls.push({ table, operation: "update", where: whereClause, values });
        return 1;
      },
      insert(values: unknown) {
        const call: RecordedDatabaseCall = { table, operation: "insert", values };
        recordedDatabaseCalls.push(call);
        const insertBuilder = {
          onConflict(conflictColumns: unknown) {
            call.conflictColumns = conflictColumns;
            return insertBuilder;
          },
          async merge(mergeColumns: unknown) {
            call.mergeColumns = mergeColumns;
          },
        };
        return insertBuilder;
      },
    };
    return builder;
  },
}));

const {
  captureTickerCalendarEvents,
  fetchDividendEvents,
  fetchEarningsEvents,
  fetchEconomicCalendarEvents,
  resolveTradingViewTicker,
  resolveTradingViewTickerDetailed,
  upsertDividendEvents,
  upsertEarningsEvents,
} = await import("./tradingviewCalendarService.js");

let fetchMock: ReturnType<typeof vi.fn>;

function replyOnce(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function insertCalls() {
  return recordedDatabaseCalls.filter((call) => call.operation === "insert");
}

function searchResult(overrides: Record<string, unknown> = {}) {
  return { symbol: "AAPL", type: "stock", exchange: "NASDAQ", country: "US", is_primary_listing: true, ...overrides };
}

// 2026-10-30 00:00:00 UTC and 2026-11-15 00:00:00 UTC
const OCTOBER_30_SECONDS = Date.UTC(2026, 9, 30) / 1000;
const NOVEMBER_15_SECONDS = Date.UTC(2026, 10, 15) / 1000;

beforeEach(() => {
  recordedDatabaseCalls.length = 0;
  storedTradingViewTickerByTickerId.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveTradingViewTickerDetailed", () => {
  it("returns the cached ticker without calling TradingView", async () => {
    storedTradingViewTickerByTickerId.set("t1", "NASDAQ:AAPL");
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: "NASDAQ:AAPL" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordedDatabaseCalls).toEqual([{ table: "tickers", operation: "first", where: { id: "t1" }, columns: ["tradingview_ticker"] }]);
  });

  it("searches TradingView with the symbol and browser-style headers when nothing is cached", async () => {
    replyOnce({ symbols: [searchResult()] });
    await resolveTradingViewTickerDetailed("t1", "AAPL");

    const [url, init] = fetchMock.mock.calls[0]!;
    const parsedUrl = new URL(url);
    expect(parsedUrl.origin + parsedUrl.pathname).toBe("https://symbol-search.tradingview.com/symbol_search/v3/");
    expect(Object.fromEntries(parsedUrl.searchParams)).toEqual({ text: "AAPL", hl: "1", exchange: "", lang: "en", search_type: "stocks", domain: "production" });
    expect(init.headers).toMatchObject({ "User-Agent": "Mozilla/5.0", Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("resolves to EXCHANGE:SYMBOL and caches it on the ticker row", async () => {
    replyOnce({ symbols: [searchResult()] });
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: "NASDAQ:AAPL" });
    expect(recordedDatabaseCalls.at(-1)).toEqual({ table: "tickers", operation: "update", where: { id: "t1" }, values: { tradingview_ticker: "NASDAQ:AAPL" } });
  });

  it("treats a row with an empty cached value as not cached", async () => {
    storedTradingViewTickerByTickerId.set("t1", null);
    replyOnce({ symbols: [searchResult()] });
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: "NASDAQ:AAPL" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("strips the <em> match highlighting from the symbol", async () => {
    replyOnce({ symbols: [searchResult({ symbol: "<em>AAPL</em>" })] });
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: "NASDAQ:AAPL" });
  });

  it("matches the symbol case-insensitively", async () => {
    replyOnce({ symbols: [searchResult({ symbol: "BRK.B", exchange: "NYSE" })] });
    expect(await resolveTradingViewTickerDetailed("t1", "brk.b")).toEqual({ tvTicker: "NYSE:BRK.B" });
  });

  it("rejects fuzzy substring matches (searching SMH must not resolve SMHI)", async () => {
    replyOnce({ symbols: [searchResult({ symbol: "<em>SMH</em>I", exchange: "NYSE" })] });
    expect(await resolveTradingViewTickerDetailed("t1", "SMH")).toEqual({ tvTicker: null, reason: "no_match" });
    expect(insertCalls()).toHaveLength(0);
    expect(recordedDatabaseCalls.some((call) => call.operation === "update")).toBe(false);
  });

  it("prefers the US primary listing over another US stock row", async () => {
    replyOnce({
      symbols: [searchResult({ exchange: "OTC", is_primary_listing: false }), searchResult({ exchange: "NASDAQ", is_primary_listing: true })],
    });
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: "NASDAQ:AAPL" });
  });

  it("falls back to a non-primary US stock listing when there is no primary one", async () => {
    replyOnce({ symbols: [searchResult({ exchange: "OTC", is_primary_listing: false })] });
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: "OTC:AAPL" });
  });

  it("resolves a US ADR typed as dr, which TradingView gives no primary-listing flag", async () => {
    replyOnce({ symbols: [searchResult({ symbol: "<em>NOK</em>", type: "dr", exchange: "NYSE", is_primary_listing: undefined })] });
    expect(await resolveTradingViewTickerDetailed("t1", "NOK")).toEqual({ tvTicker: "NYSE:NOK" });
    expect(recordedDatabaseCalls.at(-1)).toEqual({ table: "tickers", operation: "update", where: { id: "t1" }, values: { tradingview_ticker: "NYSE:NOK" } });
  });

  it("prefers the NYSE ADR over the BOATS overnight row and ignores ADR rows listed outside the US", async () => {
    replyOnce({
      symbols: [
        searchResult({ symbol: "<em>BSBR</em>", type: "dr", exchange: "BYMA", country: "AR", is_primary_listing: undefined }),
        searchResult({ symbol: "<em>BSBR</em>", type: "dr", exchange: "BOATS", is_primary_listing: undefined }),
        searchResult({ symbol: "<em>BSBR</em>", type: "dr", exchange: "NYSE", is_primary_listing: undefined }),
      ],
    });
    expect(await resolveTradingViewTickerDetailed("t1", "BSBR")).toEqual({ tvTicker: "NYSE:BSBR" });
  });

  it("prefers a US common stock over an ADR row for the same symbol", async () => {
    replyOnce({ symbols: [searchResult({ type: "dr", exchange: "NYSE", is_primary_listing: undefined }), searchResult({ exchange: "OTC", is_primary_listing: false })] });
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: "OTC:AAPL" });
  });

  it("falls back to an ADR traded only on BOATS rather than reporting no match", async () => {
    replyOnce({ symbols: [searchResult({ type: "dr", exchange: "BOATS", is_primary_listing: undefined })] });
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: "BOATS:AAPL" });
  });

  it("ignores non-stock and non-US rows", async () => {
    replyOnce({ symbols: [searchResult({ type: "fund" }), searchResult({ country: "DE", exchange: "XETR" }), searchResult({ country: undefined })] });
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: null, reason: "no_match" });
  });

  it("reports no_match for an empty result list or a missing symbols field", async () => {
    replyOnce({ symbols: [] });
    expect(await resolveTradingViewTickerDetailed("t1", "ZZZZ")).toEqual({ tvTicker: null, reason: "no_match" });
    replyOnce({});
    expect(await resolveTradingViewTickerDetailed("t1", "ZZZZ")).toEqual({ tvTicker: null, reason: "no_match" });
  });

  it("reports a lookup_error with the HTTP status when the search is rejected", async () => {
    replyOnce({}, 429);
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: null, reason: "lookup_error", detail: "symbol-search HTTP 429" });
    expect(recordedDatabaseCalls.some((call) => call.operation === "update")).toBe(false);
  });

  it("reports a lookup_error when the network call fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection reset"));
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: null, reason: "lookup_error", detail: "connection reset" });
  });

  it("stringifies a non-Error rejection into the lookup_error detail", async () => {
    fetchMock.mockRejectedValueOnce("boom");
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: null, reason: "lookup_error", detail: "boom" });
  });

  it("reports a lookup_error when the response body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    expect(await resolveTradingViewTickerDetailed("t1", "AAPL")).toEqual({ tvTicker: null, reason: "lookup_error", detail: "Unexpected token <" });
  });
});

describe("resolveTradingViewTicker", () => {
  it("returns the resolved ticker string", async () => {
    replyOnce({ symbols: [searchResult()] });
    expect(await resolveTradingViewTicker("t1", "AAPL")).toBe("NASDAQ:AAPL");
  });

  it("returns null for both no_match and lookup_error", async () => {
    replyOnce({ symbols: [] });
    expect(await resolveTradingViewTicker("t1", "ZZZZ")).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await resolveTradingViewTicker("t1", "ZZZZ")).toBeNull();
  });
});

describe("fetchEarningsEvents and fetchDividendEvents", () => {
  it("returns an empty list without a request when there are no tickers", async () => {
    expect(await fetchEarningsEvents([], 1, 2)).toEqual([]);
    expect(await fetchDividendEvents([], 1, 2)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the earnings scan request and maps each row's values onto its column names", async () => {
    replyOnce({
      data: [
        { s: "NASDAQ:AAPL", d: [1761782400, null, "amc", null, 1.64, 1.7, 0.05, 3.1, 94e9, 100e9] },
      ],
    });
    const rows = await fetchEarningsEvents(["NASDAQ:AAPL", "NYSE:KO"], OCTOBER_30_SECONDS, NOVEMBER_15_SECONDS);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://scanner.tradingview.com/global/scan?label-product=popup-watchlists");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "text/plain;charset=UTF-8", Origin: "https://www.tradingview.com" });
    const body = JSON.parse(init.body);
    expect(body.filter).toEqual([{ left: "earnings_release_date,earnings_release_next_date", operation: "in_range", right: [OCTOBER_30_SECONDS, NOVEMBER_15_SECONDS] }]);
    expect(body.symbols).toEqual({ tickers: ["NASDAQ:AAPL", "NYSE:KO"] });
    expect(body.columns).toEqual([
      "earnings_release_date",
      "earnings_release_next_date",
      "earnings_release_time",
      "earnings_release_next_time",
      "earnings_per_share_fq",
      "earnings_per_share_forecast_next_fq",
      "eps_surprise_fq",
      "eps_surprise_percent_fq",
      "revenue_fq",
      "revenue_forecast_next_fq",
    ]);
    expect(rows).toEqual([
      {
        tvTicker: "NASDAQ:AAPL",
        earnings_release_date: 1761782400,
        earnings_release_next_date: null,
        earnings_release_time: "amc",
        earnings_release_next_time: null,
        earnings_per_share_fq: 1.64,
        earnings_per_share_forecast_next_fq: 1.7,
        eps_surprise_fq: 0.05,
        eps_surprise_percent_fq: 3.1,
        revenue_fq: 94e9,
        revenue_forecast_next_fq: 100e9,
      },
    ]);
  });

  it("posts the dividend scan request with the dividend columns and filter", async () => {
    replyOnce({ data: [{ s: "NYSE:KO", d: [1760000000, 1768000000, 1761000000, 1769000000, 0.51, 0.53] }] });
    const rows = await fetchDividendEvents(["NYSE:KO"], 10, 20);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.filter).toEqual([{ left: "dividend_ex_date_recent,dividend_ex_date_upcoming", operation: "in_range", right: [10, 20] }]);
    expect(body.columns).toEqual([
      "dividend_ex_date_recent",
      "dividend_ex_date_upcoming",
      "dividend_payment_date_recent",
      "dividend_payment_date_upcoming",
      "dividend_amount_recent",
      "dividend_amount_upcoming",
    ]);
    expect(rows).toEqual([
      {
        tvTicker: "NYSE:KO",
        dividend_ex_date_recent: 1760000000,
        dividend_ex_date_upcoming: 1768000000,
        dividend_payment_date_recent: 1761000000,
        dividend_payment_date_upcoming: 1769000000,
        dividend_amount_recent: 0.51,
        dividend_amount_upcoming: 0.53,
      },
    ]);
  });

  it("returns an empty list when the scanner has no data field or no rows", async () => {
    replyOnce({});
    expect(await fetchEarningsEvents(["NASDAQ:AAPL"], 1, 2)).toEqual([]);
    replyOnce({ data: [] });
    expect(await fetchDividendEvents(["NASDAQ:AAPL"], 1, 2)).toEqual([]);
  });

  it("leaves columns undefined when a row carries fewer values than columns", async () => {
    replyOnce({ data: [{ s: "NASDAQ:AAPL", d: [1761782400] }] });
    const [row] = await fetchEarningsEvents(["NASDAQ:AAPL"], 1, 2);
    expect(row!.earnings_release_date).toBe(1761782400);
    expect(row!.revenue_fq).toBeUndefined();
  });

  it("throws on an HTTP error from the scanner", async () => {
    replyOnce({}, 503);
    await expect(fetchEarningsEvents(["NASDAQ:AAPL"], 1, 2)).rejects.toThrow("scanner.tradingview.com HTTP 503");
  });
});

describe("upsertEarningsEvents", () => {
  const tickerIdByTvTicker = new Map([["NASDAQ:AAPL", "ticker-aapl"]]);

  it("writes one event per non-null earnings date with its matching release time", async () => {
    const row = {
      tvTicker: "NASDAQ:AAPL",
      earnings_release_date: OCTOBER_30_SECONDS,
      earnings_release_time: "amc",
      earnings_release_next_date: NOVEMBER_15_SECONDS,
      earnings_release_next_time: "bmo",
    };
    expect(await upsertEarningsEvents([row], tickerIdByTvTicker)).toBe(2);

    expect(insertCalls()).toEqual([
      {
        table: "ticker_calendar_events",
        operation: "insert",
        values: { ticker_id: "ticker-aapl", event_type: "earnings", event_date: "2026-10-30", event_time: "amc", raw: JSON.stringify(row) },
        conflictColumns: ["ticker_id", "event_type", "event_date"],
        mergeColumns: ["event_time", "raw", "captured_at"],
      },
      {
        table: "ticker_calendar_events",
        operation: "insert",
        values: { ticker_id: "ticker-aapl", event_type: "earnings", event_date: "2026-11-15", event_time: "bmo", raw: JSON.stringify(row) },
        conflictColumns: ["ticker_id", "event_type", "event_date"],
        mergeColumns: ["event_time", "raw", "captured_at"],
      },
    ]);
  });

  it("skips a null or missing date and stores a missing time as null", async () => {
    const row = { tvTicker: "NASDAQ:AAPL", earnings_release_date: null, earnings_release_next_date: NOVEMBER_15_SECONDS };
    expect(await upsertEarningsEvents([row], tickerIdByTvTicker)).toBe(1);
    expect(insertCalls()).toHaveLength(1);
    expect(insertCalls()[0]!.values).toMatchObject({ event_date: "2026-11-15", event_time: null });
  });

  it("stringifies a numeric release time", async () => {
    await upsertEarningsEvents([{ tvTicker: "NASDAQ:AAPL", earnings_release_date: OCTOBER_30_SECONDS, earnings_release_time: 1 }], tickerIdByTvTicker);
    expect(insertCalls()[0]!.values).toMatchObject({ event_time: "1" });
  });

  it("derives the date in UTC from the unix seconds", async () => {
    await upsertEarningsEvents([{ tvTicker: "NASDAQ:AAPL", earnings_release_date: Date.UTC(2026, 10, 15, 23, 59, 59) / 1000 }], tickerIdByTvTicker);
    expect(insertCalls()[0]!.values).toMatchObject({ event_date: "2026-11-15" });
  });

  it("skips rows whose TradingView ticker is unknown", async () => {
    expect(await upsertEarningsEvents([{ tvTicker: "NYSE:UNKNOWN", earnings_release_date: OCTOBER_30_SECONDS }], tickerIdByTvTicker)).toBe(0);
    expect(insertCalls()).toHaveLength(0);
  });

  it("returns 0 for no rows", async () => {
    expect(await upsertEarningsEvents([], tickerIdByTvTicker)).toBe(0);
  });

  it("maps several rows to their own ticker ids", async () => {
    const mapping = new Map([
      ["NASDAQ:AAPL", "ticker-aapl"],
      ["NYSE:KO", "ticker-ko"],
    ]);
    await upsertEarningsEvents(
      [
        { tvTicker: "NASDAQ:AAPL", earnings_release_date: OCTOBER_30_SECONDS },
        { tvTicker: "NYSE:KO", earnings_release_date: NOVEMBER_15_SECONDS },
      ],
      mapping,
    );
    expect(insertCalls().map((call) => (call.values as { ticker_id: string }).ticker_id)).toEqual(["ticker-aapl", "ticker-ko"]);
  });
});

describe("upsertDividendEvents", () => {
  const tickerIdByTvTicker = new Map([["NYSE:KO", "ticker-ko"]]);

  it("writes ex-dividend events for the recent and upcoming dates with their amounts", async () => {
    const row = {
      tvTicker: "NYSE:KO",
      dividend_ex_date_recent: OCTOBER_30_SECONDS,
      dividend_amount_recent: 0.51,
      dividend_ex_date_upcoming: NOVEMBER_15_SECONDS,
      dividend_amount_upcoming: "0.53",
    };
    expect(await upsertDividendEvents([row], tickerIdByTvTicker)).toBe(2);

    expect(insertCalls()).toEqual([
      {
        table: "ticker_calendar_events",
        operation: "insert",
        values: { ticker_id: "ticker-ko", event_type: "ex_dividend", event_date: "2026-10-30", amount: 0.51, raw: JSON.stringify(row) },
        conflictColumns: ["ticker_id", "event_type", "event_date"],
        mergeColumns: ["amount", "raw", "captured_at"],
      },
      {
        table: "ticker_calendar_events",
        operation: "insert",
        values: { ticker_id: "ticker-ko", event_type: "ex_dividend", event_date: "2026-11-15", amount: 0.53, raw: JSON.stringify(row) },
        conflictColumns: ["ticker_id", "event_type", "event_date"],
        mergeColumns: ["amount", "raw", "captured_at"],
      },
    ]);
  });

  it("skips null dates and stores a missing amount as null", async () => {
    const row = { tvTicker: "NYSE:KO", dividend_ex_date_recent: null, dividend_ex_date_upcoming: NOVEMBER_15_SECONDS, dividend_amount_upcoming: null };
    expect(await upsertDividendEvents([row], tickerIdByTvTicker)).toBe(1);
    expect(insertCalls()[0]!.values).toMatchObject({ event_date: "2026-11-15", amount: null });
  });

  it("keeps a zero amount instead of treating it as missing", async () => {
    await upsertDividendEvents([{ tvTicker: "NYSE:KO", dividend_ex_date_recent: OCTOBER_30_SECONDS, dividend_amount_recent: 0 }], tickerIdByTvTicker);
    expect(insertCalls()[0]!.values).toMatchObject({ amount: 0 });
  });

  it("skips rows whose TradingView ticker is unknown", async () => {
    expect(await upsertDividendEvents([{ tvTicker: "NYSE:UNKNOWN", dividend_ex_date_recent: OCTOBER_30_SECONDS }], tickerIdByTvTicker)).toBe(0);
    expect(insertCalls()).toHaveLength(0);
  });
});

describe("captureTickerCalendarEvents", () => {
  it("returns an unresolved result without scanning when the ticker cannot be resolved", async () => {
    replyOnce({ symbols: [] });
    expect(await captureTickerCalendarEvents("t1", "SMH")).toEqual({ resolved: false, tvTicker: null, earningsWritten: 0, dividendsWritten: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(insertCalls()).toHaveLength(0);
  });

  it("scans from 30 days back to 90 days ahead and writes earnings and dividends for the resolved ticker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    const nowSeconds = Math.floor(Date.now() / 1000);
    storedTradingViewTickerByTickerId.set("t1", "NYSE:KO");
    replyOnce({ data: [{ s: "NYSE:KO", d: [OCTOBER_30_SECONDS, null, "bmo", null, null, null, null, null, null, null] }] });
    replyOnce({ data: [{ s: "NYSE:KO", d: [OCTOBER_30_SECONDS, NOVEMBER_15_SECONDS, null, null, 0.51, 0.53] }] });

    const result = await captureTickerCalendarEvents("t1", "KO");

    expect(result).toEqual({ resolved: true, tvTicker: "NYSE:KO", earningsWritten: 1, dividendsWritten: 2 });
    const expectedRange = [nowSeconds - 30 * 86400, nowSeconds + 90 * 86400];
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init.body);
      expect(body.filter[0].right).toEqual(expectedRange);
      expect(body.symbols).toEqual({ tickers: ["NYSE:KO"] });
    }
    const eventTypes = insertCalls().map((call) => (call.values as { event_type: string }).event_type);
    expect(eventTypes.sort()).toEqual(["earnings", "ex_dividend", "ex_dividend"]);
    expect(insertCalls().every((call) => (call.values as { ticker_id: string }).ticker_id === "t1")).toBe(true);
  });

  it("resolves and caches the ticker first when it is not stored yet", async () => {
    replyOnce({ symbols: [searchResult({ symbol: "KO", exchange: "NYSE" })] });
    replyOnce({ data: [] });
    replyOnce({ data: [] });

    expect(await captureTickerCalendarEvents("t1", "KO")).toEqual({ resolved: true, tvTicker: "NYSE:KO", earningsWritten: 0, dividendsWritten: 0 });
    expect(recordedDatabaseCalls.some((call) => call.operation === "update" && (call.values as { tradingview_ticker: string }).tradingview_ticker === "NYSE:KO")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects when a scanner request fails, before writing anything", async () => {
    storedTradingViewTickerByTickerId.set("t1", "NYSE:KO");
    replyOnce({ data: [] });
    replyOnce({}, 500);
    await expect(captureTickerCalendarEvents("t1", "KO")).rejects.toThrow("scanner.tradingview.com HTTP 500");
    expect(insertCalls()).toHaveLength(0);
  });
});

describe("fetchEconomicCalendarEvents", () => {
  it("requests the window for the US by default and returns the events", async () => {
    const events = [{ id: "e1", title: "CPI", country: "US", category: "inflation", importance: 1, actual: null, forecast: 0.3, previous: 0.2, date: "2026-10-14T12:30:00.000Z" }];
    replyOnce({ result: events });
    const outcome = await fetchEconomicCalendarEvents("2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z");

    const [url, init] = fetchMock.mock.calls[0]!;
    const parsedUrl = new URL(url);
    expect(parsedUrl.origin + parsedUrl.pathname).toBe("https://economic-calendar.tradingview.com/events");
    expect(Object.fromEntries(parsedUrl.searchParams)).toEqual({ from: "2026-10-14T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z", countries: "US" });
    expect(init.headers).toMatchObject({ Origin: "https://www.tradingview.com" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(outcome).toEqual(events);
  });

  it("passes a custom country list through", async () => {
    replyOnce({ result: [] });
    await fetchEconomicCalendarEvents("a", "b", "US,EU");
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("countries")).toBe("US,EU");
  });

  it("returns an empty list when the response has no result field", async () => {
    replyOnce({});
    expect(await fetchEconomicCalendarEvents("a", "b")).toEqual([]);
  });

  it("throws on an HTTP error", async () => {
    replyOnce({}, 500);
    await expect(fetchEconomicCalendarEvents("a", "b")).rejects.toThrow("economic-calendar.tradingview.com HTTP 500");
  });

  it("propagates a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(fetchEconomicCalendarEvents("a", "b")).rejects.toThrow("timeout");
  });
});
