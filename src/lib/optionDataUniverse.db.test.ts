import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// The option-data universe (optionDataUniverse.ts) against the test database: active Shortlist entries plus open positions
// other than a hedge or a LEAPS, a removed entry out, a ticker being set up left out of the structure refresh unless a position keeps
// it in; and its consumers: the stale daily-bar check and Price Performance's 3M/1Y reference closes. Only the session
// clock is mocked; assertions are narrowed to this file's rows.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the option-data universe tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => undefined) }));
vi.mock("./marketSessionStatus.js", async () => {
  const actual = await vi.importActual<typeof import("./marketSessionStatus.js")>("./marketSessionStatus.js");
  return { ...actual, lastCompletedSessionDate: async () => "2026-10-05" };
});

const { db } = await import("../db/connection.js");
const { loadOptionDataUniverse } = await import("./optionDataUniverse.js");
const { loadDataInvariantInputs } = await import("./dataInvariants.js");
const { getPricePerformanceSnapshot, invalidatePricePerformanceSnapshot } = await import("./pricePerformanceSnapshot.js");
const testDb: Knex = db;

const suffix = String(Date.now() % 1_000_000);
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
let userId: string;
const tickers: Record<string, { id: string; symbol: string }> = {};

async function insertTicker(label: string): Promise<{ id: string; symbol: string }> {
  const symbol = `OU${label}${suffix}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: `${symbol} Co`, ibkr_contract_id: 999 }).returning("id");
  createdTickerIds.push(ticker.id);
  tickers[label] = { id: ticker.id, symbol };
  return tickers[label]!;
}

// Inserted closed and flipped open once its leg exists: another file's reconciliation sweep closes an open position with no open leg.
async function insertOpenPosition(tickerId: string, strategyKey: "cash_secured_put" | "hedge" | "leaps"): Promise<void> {
  const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status: "closed", closed_at: new Date() }).returning("id");
  createdPositionIds.push(position.id);
  const leg = strategyKey === "hedge" ? { side: "long", option_type: "put" } : strategyKey === "leaps" ? { side: "long", option_type: "call" } : { side: "short", option_type: "put" };
  await testDb("position_legs").insert({ position_id: position.id, leg_type: "option", quantity: 1, multiplier: 100, strike_price: 50, expiry_date: "2031-01-17", entry_price: 1, entry_at: new Date(), ...leg });
  await testDb("positions").where({ id: position.id }).update({ status: "open", closed_at: null });
}

async function insertBar(tickerId: string, tradingDate: string, close: number) {
  await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: tradingDate, open_price: close, high_price: close, low_price: close, close_price: close, volume: 1000 });
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `option-data-universe-${Date.now()}`, display_name: "Option Data Universe Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  const listed = await insertTicker("LIST");
  const removed = await insertTicker("REM");
  const preparing = await insertTicker("PREP");
  const preparingWithPosition = await insertTicker("PREPPOS");
  const offListPut = await insertTicker("PUT");
  const offListHedge = await insertTicker("HDG");
  const offListLeaps = await insertTicker("LEAPS");
  await testDb("shortlist_entries").insert([
    { ticker_id: listed.id, added_by_user_id: userId },
    // DELETE only sets removed_at: the row stays.
    { ticker_id: removed.id, added_by_user_id: userId, removed_at: new Date() },
    { ticker_id: preparing.id, added_by_user_id: userId },
    { ticker_id: preparingWithPosition.id, added_by_user_id: userId },
  ]);
  await insertOpenPosition(preparingWithPosition.id, "cash_secured_put");
  await insertOpenPosition(offListPut.id, "cash_secured_put");
  await insertOpenPosition(offListHedge.id, "hedge");
  await insertOpenPosition(offListLeaps.id, "leaps");
  await testDb("ticker_backfill_runs").insert([
    { ticker_id: preparing.id, status: "running", steps: JSON.stringify([]), progress_percent: 0 },
    { ticker_id: preparingWithPosition.id, status: "running", steps: JSON.stringify([]), progress_percent: 0 },
  ]);
  // Latest completed session 2026-10-05. 3M looks up the last close on or before 2026-07-06 (91 days back), 1Y on or before
  // 2025-10-05 (365 days back, a Sunday, so the Friday 2025-10-03 close). The bars just after each cutoff must not be used.
  await insertBar(listed.id, "2026-10-05", 110);
  await insertBar(listed.id, "2026-07-07", 999);
  await insertBar(listed.id, "2026-07-02", 100);
  await insertBar(listed.id, "2025-10-06", 999);
  await insertBar(listed.id, "2025-10-03", 55);
  await insertBar(offListPut.id, "2026-10-02", 20);
  invalidatePricePerformanceSnapshot();
});

afterAll(async () => {
  await testDb("ticker_backfill_runs").whereIn("ticker_id", createdTickerIds).del();
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("daily_price_bars").whereIn("ticker_id", createdTickerIds).del();
  await testDb("shortlist_entries").whereIn("ticker_id", createdTickerIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

const mineSymbols = (symbols: string[]) =>
  symbols
    .map((symbol) => Object.entries(tickers).find(([, ticker]) => ticker.symbol === symbol)?.[0])
    .filter((label): label is string => label !== undefined)
    .sort();

describe("loadOptionDataUniverse", () => {
  it("is every active Shortlist entry plus every open position other than a hedge or a LEAPS; a removed entry, a hedge and a LEAPS alone are out", async () => {
    expect(mineSymbols((await loadOptionDataUniverse()).map((ticker) => ticker.symbol))).toEqual(["LIST", "PREP", "PREPPOS", "PUT"]);
  });

  it("leaves out a Shortlist ticker being set up, unless an open position keeps it in", async () => {
    expect(mineSymbols((await loadOptionDataUniverse({ excludeBeingPrepared: true })).map((ticker) => ticker.symbol))).toEqual(["LIST", "PREPPOS", "PUT"]);
  });

  it("returns the contract id as a number", async () => {
    const listed = (await loadOptionDataUniverse()).find((ticker) => ticker.symbol === tickers.LIST!.symbol);
    expect(listed).toMatchObject({ tickerId: tickers.LIST!.id, contractId: 999 });
  });
});

describe("the stale daily-bar check", () => {
  it("covers the universe but skips every ticker being set up (its setup fetches the bars), and flags a ticker behind the last session", async () => {
    const inputs = await loadDataInvariantInputs(new Date("2026-10-06T14:00:00Z"), "2026-10-06");
    expect(mineSymbols(Object.keys(inputs.latestBarDateBySymbol))).toEqual(["LIST", "PUT"]);
    expect(inputs.latestBarDateBySymbol[tickers.LIST!.symbol]).toBe("2026-10-05");
    expect(inputs.latestBarDateBySymbol[tickers.PUT!.symbol]).toBe("2026-10-02");
  });
});

describe("Price Performance", () => {
  it("measures 3M and 1Y from the last close on or before 91 and 365 days back", async () => {
    const { tickers: rows } = await getPricePerformanceSnapshot(new Date("2026-10-06T14:00:00Z"));
    expect(rows.find((row) => row.symbol === tickers.LIST!.symbol)).toMatchObject({
      latestClose: "110.0000",
      referenceCloses: expect.objectContaining({ close3mAgo: 100, close1yAgo: 55 }),
      change3m: 10,
      change1y: 100,
    });
  });
});
