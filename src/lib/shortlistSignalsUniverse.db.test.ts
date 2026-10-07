import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// The per-ticker Signals flag against the test database: which universes a Signals-off shortlist ticker is in (price data) and
// out of (option-chain capture, Signals), and the Price Performance SQL's 3M/1Y reference closes. Only the session clock is mocked.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run shortlist Signals universe tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("./marketSessionStatus.js", async () => {
  const actual = await vi.importActual<typeof import("./marketSessionStatus.js")>("./marketSessionStatus.js");
  return { ...actual, lastCompletedSessionDate: async () => "2026-10-05" };
});

const { db } = await import("../db/connection.js");
const { loadCaptureUniverse } = await import("../ibkr/runOptionChainCapture.js");
const { loadSignalsUniverseTickers } = await import("./signalsStore.js");
const { loadDataInvariantInputs } = await import("./dataInvariants.js");
const { getPricePerformanceSnapshot, invalidatePricePerformanceSnapshot } = await import("./pricePerformanceSnapshot.js");

const testDb: Knex = db;
const suffix = String(Date.now() % 1_000_000);
const signalsOnSymbol = `SGON${suffix}`;
const signalsOffSymbol = `SGOF${suffix}`;
const createdTickerIds: string[] = [];
let userId: string;

async function insertTicker(symbol: string): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: `${symbol} Co`, ibkr_contract_id: 777 }).returning("id");
  createdTickerIds.push(ticker.id);
  return ticker.id;
}

async function insertBar(tickerId: string, tradingDate: string, close: number) {
  await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: tradingDate, open_price: close, high_price: close, low_price: close, close_price: close, volume: 1000 });
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `signals-universe-${Date.now()}`, display_name: "Signals Universe Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  const signalsOnId = await insertTicker(signalsOnSymbol);
  const signalsOffId = await insertTicker(signalsOffSymbol);
  await testDb("shortlist_entries").insert([
    { ticker_id: signalsOnId, added_by_user_id: userId, signals_enabled: true },
    { ticker_id: signalsOffId, added_by_user_id: userId, signals_enabled: false },
  ]);
  // Latest completed session 2026-10-05. 3M looks up the last close on or before 2026-07-06 (91 days back), 1Y on or before
  // 2025-10-05 (365 days back, a Sunday, so the Friday 2025-10-03 close). The bars just after each cutoff must not be used.
  await insertBar(signalsOffId, "2026-10-05", 110);
  await insertBar(signalsOffId, "2026-07-07", 999);
  await insertBar(signalsOffId, "2026-07-02", 100);
  await insertBar(signalsOffId, "2025-10-06", 999);
  await insertBar(signalsOffId, "2025-10-03", 55);
  await testDb("market_data_snapshots").insert({ ticker_id: signalsOffId, snapshot_date: "2026-09-01", implied_volatility: 0.5, avg_option_volume: 900 });
  await insertBar(signalsOnId, "2026-10-05", 20);
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

const mine = (symbols: string[]) => symbols.filter((symbol) => symbol === signalsOnSymbol || symbol === signalsOffSymbol);

describe("a Signals-off shortlist ticker", () => {
  it("is left out of the option-chain capture universe", async () => {
    expect(mine((await loadCaptureUniverse()).map((ticker) => ticker.symbol))).toEqual([signalsOnSymbol]);
  });

  it("is left out of the Signals universe", async () => {
    expect(mine((await loadSignalsUniverseTickers()).map((ticker) => ticker.symbol))).toEqual([signalsOnSymbol]);
  });

  it("is still checked for stale daily bars, but not for option-chain snapshots", async () => {
    const inputs = await loadDataInvariantInputs(new Date("2026-10-06T14:00:00Z"), "2026-10-06");
    expect(mine(inputs.universeSymbols)).toEqual([signalsOnSymbol]);
    expect(inputs.latestBarDateBySymbol[signalsOffSymbol]).toBe("2026-10-05");
    expect(inputs.latestBarDateBySymbol[signalsOnSymbol]).toBe("2026-10-05");
  });

  it("is on Price Performance, with 3M and 1Y measured from the last close on or before 91 and 365 days back, and no stale IV", async () => {
    const { tickers } = await getPricePerformanceSnapshot(new Date("2026-10-06T14:00:00Z"));
    const row = tickers.find((ticker) => ticker.symbol === signalsOffSymbol);
    expect(row).toMatchObject({
      signalsEnabled: false,
      latestClose: "110.0000",
      referenceCloses: expect.objectContaining({ close3mAgo: 100, close1yAgo: 55 }),
      change3m: 10,
      change1y: 100,
      impliedVolatility: null,
      avgOptionVolume: null,
    });
    const signalsOnRow = tickers.find((ticker) => ticker.symbol === signalsOnSymbol);
    expect(signalsOnRow).toMatchObject({ signalsEnabled: true, change3m: null, change1y: null });
  });
});
