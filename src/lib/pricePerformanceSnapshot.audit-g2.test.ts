import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// Audit (G2, 2026-10-07): Price Performance 3M / 1Y ("last close on or before 91 / 365 calendar days back") over weekends,
// holidays, missing bars, a ticker behind the others and short histories, plus the shortlist JOIN that replaced the EXISTS.
// Only the session clock is mocked; rows are real and every assertion is narrowed to this file's tickers.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the price performance audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => undefined) }));
let completedSession = "2026-10-05";
vi.mock("./marketSessionStatus.js", async () => {
  const actual = await vi.importActual<typeof import("./marketSessionStatus.js")>("./marketSessionStatus.js");
  return { ...actual, lastCompletedSessionDate: async () => completedSession };
});

const { db } = await import("../db/connection.js");
const { getPricePerformanceSnapshot, invalidatePricePerformanceSnapshot } = await import("./pricePerformanceSnapshot.js");
const testDb: Knex = db;

const suffix = String(Date.now() % 1_000_000);
const createdTickerIds: string[] = [];
let userId: string;
let symbolCounter = 0;

async function shortlistedTicker(options: { signalsEnabled?: boolean } = {}): Promise<{ id: string; symbol: string }> {
  symbolCounter += 1;
  const symbol = `PP${symbolCounter}X${suffix}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: `${symbol} Co`, ibkr_contract_id: 888 }).returning("id");
  createdTickerIds.push(ticker.id);
  await testDb("shortlist_entries").insert({ ticker_id: ticker.id, added_by_user_id: userId, signals_enabled: options.signalsEnabled ?? true });
  return { id: ticker.id, symbol };
}

async function bars(tickerId: string, closesByDate: Record<string, number>) {
  await testDb("daily_price_bars").insert(
    Object.entries(closesByDate).map(([tradingDate, close]) => ({ ticker_id: tickerId, trading_date: tradingDate, open_price: close, high_price: close, low_price: close, close_price: close, volume: 1000 })),
  );
}

async function rowFor(symbol: string, session: string) {
  completedSession = session;
  invalidatePricePerformanceSnapshot();
  const { tickers } = await getPricePerformanceSnapshot(new Date(`${session}T23:59:00Z`));
  return tickers.filter((ticker) => ticker.symbol === symbol);
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `price-perf-audit-${Date.now()}`, display_name: "Price Performance Audit", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
});

beforeEach(() => {
  invalidatePricePerformanceSnapshot();
});

afterAll(async () => {
  await testDb("market_data_snapshots").whereIn("ticker_id", createdTickerIds).del();
  await testDb("daily_price_bars").whereIn("ticker_id", createdTickerIds).del();
  await testDb("shortlist_entries").whereIn("ticker_id", createdTickerIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("3M and 1Y reference closes", () => {
  it("uses a bar dated exactly 91 / 365 days back (on or before includes the day itself)", async () => {
    const ticker = await shortlistedTicker();
    // 2026-10-05 - 91 days = 2026-07-06 (Mon); - 365 days = 2025-10-05 (Sun, so the exact-day case is 3M only here).
    await bars(ticker.id, { "2026-10-05": 120, "2026-07-06": 100, "2026-07-02": 1, "2026-07-07": 999, "2025-10-03": 60, "2025-10-06": 999 });

    const [row] = await rowFor(ticker.symbol, "2026-10-05");
    expect(row!.referenceCloses).toMatchObject({ close3mAgo: 100, close1yAgo: 60 });
    expect(row!.change3m).toBeCloseTo(20, 10);
    expect(row!.change1y).toBeCloseTo(100, 10);
  });

  it("a cutoff on a market holiday falls back to the session before it (1Y over Thanksgiving 2025)", async () => {
    const ticker = await shortlistedTicker();
    // 2026-11-27 (Fri) - 365 days = 2025-11-27, Thanksgiving: the Wednesday close is the reference. 3M: 2026-08-28 (Fri).
    await bars(ticker.id, { "2026-11-27": 80, "2026-08-28": 64, "2026-08-31": 999, "2025-11-26": 40, "2025-11-28": 999 });

    const [row] = await rowFor(ticker.symbol, "2026-11-27");
    expect(row!.referenceCloses).toMatchObject({ close3mAgo: 64, close1yAgo: 40 });
    expect(row!.change1y).toBeCloseTo(100, 10);
  });

  it("is null, not some later close, when the history is shorter than a year", async () => {
    const ticker = await shortlistedTicker();
    await bars(ticker.id, { "2026-10-05": 50, "2026-06-01": 25, "2026-01-02": 20 });

    const [row] = await rowFor(ticker.symbol, "2026-10-05");
    expect(row!.referenceCloses).toMatchObject({ close3mAgo: 25, close1yAgo: null });
    expect(row).toMatchObject({ change3m: 100, change1y: null });
  });

  it("ignores a bar after the completed session (a partial in-progress bar) both as latest and as a base", async () => {
    const ticker = await shortlistedTicker();
    await bars(ticker.id, { "2026-10-06": 999, "2026-10-05": 110, "2026-07-02": 100 });

    const [row] = await rowFor(ticker.symbol, "2026-10-05");
    expect(row).toMatchObject({ latestDate: "2026-10-05", change3m: expect.closeTo(10, 10) });
  });

  it("a ticker behind the others measures 3M back from its own latest bar", async () => {
    const ticker = await shortlistedTicker();
    // Latest bar 2026-10-01; 91 days back = 2026-07-02.
    await bars(ticker.id, { "2026-10-01": 90, "2026-07-02": 60, "2026-07-03": 999, "2026-07-06": 999 });

    const [row] = await rowFor(ticker.symbol, "2026-10-05");
    expect(row).toMatchObject({ latestDate: "2026-10-01", isBehind: true, referenceCloses: expect.objectContaining({ close3mAgo: 60 }) });
  });

  it("weekend and observed-holiday cutoffs: 1Y on a Sunday and 3M on the observed July 4th both use the session before", async () => {
    const ticker = await shortlistedTicker();
    // 2026-10-02 (Fri) - 91 days = 2026-07-03 (Fri, Independence Day observed) -> Thu 2026-07-02.
    // 2026-10-02 - 365 days = 2025-10-02 (Thu), a session: used as is. Then 2026-10-05 (Mon) - 365 = 2025-10-05 (Sun) -> Fri 2025-10-03.
    await bars(ticker.id, { "2026-10-02": 30, "2026-07-02": 20, "2026-07-06": 25, "2025-10-02": 12, "2025-10-03": 15, "2025-10-06": 999 });

    const [friday] = await rowFor(ticker.symbol, "2026-10-02");
    expect(friday!.referenceCloses).toMatchObject({ close3mAgo: 20, close1yAgo: 12 });
    await bars(ticker.id, { "2026-10-05": 30 });
    const [monday] = await rowFor(ticker.symbol, "2026-10-05");
    expect(monday!.referenceCloses).toMatchObject({ close3mAgo: 25, close1yAgo: 15 });
  });

  it("a long gap in the bars: 3M falls back to the last close before the gap, however old (same rule as 1W/1M)", async () => {
    const ticker = await shortlistedTicker();
    // Nothing between 2026-03-02 and 2026-10-05: the "3M" base is seven months old.
    await bars(ticker.id, { "2026-10-05": 70, "2026-03-02": 35 });

    const [row] = await rowFor(ticker.symbol, "2026-10-05");
    expect(row!.referenceCloses).toMatchObject({ close1mAgo: 35, close3mAgo: 35, close1yAgo: null });
  });
});

describe("shortlist membership", () => {
  it("a ticker removed once and re-added appears exactly once, with the active entry's Signals flag", async () => {
    const ticker = await shortlistedTicker({ signalsEnabled: false });
    await testDb("shortlist_entries").where({ ticker_id: ticker.id }).update({ removed_at: new Date(), signals_enabled: true, bot_enabled: true });
    await testDb("shortlist_entries").insert({ ticker_id: ticker.id, added_by_user_id: userId, signals_enabled: false });
    await bars(ticker.id, { "2026-10-05": 10 });

    const rows = await rowFor(ticker.symbol, "2026-10-05");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ signalsEnabled: false });
  });

  it("a removed-only ticker is not listed", async () => {
    const ticker = await shortlistedTicker();
    await testDb("shortlist_entries").where({ ticker_id: ticker.id }).update({ removed_at: new Date() });
    await bars(ticker.id, { "2026-10-05": 10 });

    expect(await rowFor(ticker.symbol, "2026-10-05")).toHaveLength(0);
  });

  it("a Signals-on ticker keeps its IV and option volume; Signals-off hides them", async () => {
    const on = await shortlistedTicker({ signalsEnabled: true });
    const off = await shortlistedTicker({ signalsEnabled: false });
    for (const ticker of [on, off]) {
      await bars(ticker.id, { "2026-10-05": 10 });
      await testDb("market_data_snapshots").insert({ ticker_id: ticker.id, snapshot_date: "2026-10-05", implied_volatility: 0.42, avg_option_volume: 1234 });
    }

    const [onRow] = await rowFor(on.symbol, "2026-10-05");
    const [offRow] = await rowFor(off.symbol, "2026-10-05");
    expect(onRow).toMatchObject({ signalsEnabled: true, impliedVolatility: expect.stringMatching(/^0\.42/), avgOptionVolume: expect.anything() });
    expect(offRow).toMatchObject({ signalsEnabled: false, impliedVolatility: null, avgOptionVolume: null });
  });
});
