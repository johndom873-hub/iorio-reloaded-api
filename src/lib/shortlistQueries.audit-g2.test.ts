import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// Audit (G2, 2026-10-07): the two shortlist universes (shortlistQueries.ts) and their consumers for the corner cases the commit's
// own tests leave out: removed entries that still carry Signals/Pluto flags, a Signals-off ticker with an open position, and a
// Signals-off ticker being prepared. Only the session clock is mocked; rows are real and assertions are narrowed to this file.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the shortlist queries audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => undefined) }));
vi.mock("./marketSessionStatus.js", async () => {
  const actual = await vi.importActual<typeof import("./marketSessionStatus.js")>("./marketSessionStatus.js");
  return { ...actual, lastCompletedSessionDate: async () => "2026-10-05" };
});

const { db } = await import("../db/connection.js");
const { activeShortlistTickerIdsQuery, signalsEnabledShortlistTickerIdsQuery } = await import("./shortlistQueries.js");
const { loadCaptureUniverse } = await import("../ibkr/runOptionChainCapture.js");
const { loadSignalsUniverseTickers } = await import("./signalsStore.js");
const { loadDataInvariantInputs } = await import("./dataInvariants.js");
const testDb: Knex = db;

const suffix = String(Date.now() % 1_000_000);
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
let userId: string;
const tickers: Record<string, { id: string; symbol: string }> = {};

async function insertTicker(label: string): Promise<{ id: string; symbol: string }> {
  const symbol = `SQ${label}${suffix}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: `${symbol} Co`, ibkr_contract_id: 999 }).returning("id");
  createdTickerIds.push(ticker.id);
  tickers[label] = { id: ticker.id, symbol };
  return tickers[label]!;
}

// Inserted closed and flipped open once its leg exists: another file's reconciliation sweep closes an open position with no open leg.
async function insertOpenShortPut(tickerId: string): Promise<void> {
  const [position] = await testDb("positions").insert({ strategy_key: "cash_secured_put", ticker_id: tickerId, status: "closed", closed_at: new Date() }).returning("id");
  createdPositionIds.push(position.id);
  await testDb("position_legs").insert({ position_id: position.id, leg_type: "option", side: "short", quantity: 1, multiplier: 100, option_type: "put", strike_price: 50, expiry_date: "2031-01-17", entry_price: 1, entry_at: new Date() });
  await testDb("positions").where({ id: position.id }).update({ status: "open", closed_at: null });
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `shortlist-queries-audit-${Date.now()}`, display_name: "Shortlist Queries Audit", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  const on = await insertTicker("ON");
  const off = await insertTicker("OFF");
  const offWithPosition = await insertTicker("OFFPOS");
  const removedFlagged = await insertTicker("REMFLAG");
  const offPreparing = await insertTicker("OFFPREP");
  await testDb("shortlist_entries").insert([
    { ticker_id: on.id, added_by_user_id: userId, signals_enabled: true },
    { ticker_id: off.id, added_by_user_id: userId, signals_enabled: false },
    { ticker_id: offWithPosition.id, added_by_user_id: userId, signals_enabled: false },
    // Removed while Signals and Pluto were on: the flags stay on the removed row (DELETE only sets removed_at).
    { ticker_id: removedFlagged.id, added_by_user_id: userId, signals_enabled: true, bot_enabled: true, removed_at: new Date() },
    { ticker_id: offPreparing.id, added_by_user_id: userId, signals_enabled: false },
  ]);
  await insertOpenShortPut(offWithPosition.id);
  for (const ticker of [on, off, offWithPosition, offPreparing]) {
    await testDb("daily_price_bars").insert({ ticker_id: ticker.id, trading_date: "2026-10-05", open_price: 10, high_price: 10, low_price: 10, close_price: 10, volume: 1 });
  }
  await testDb("ticker_backfill_runs").insert({ ticker_id: offPreparing.id, status: "running", steps: JSON.stringify([]), progress_percent: 0 });
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

const mineSorted = (ids: string[]) => ids.filter((id) => createdTickerIds.includes(id)).map((id) => Object.entries(tickers).find(([, ticker]) => ticker.id === id)![0]).sort();
const mineSymbols = (symbols: string[]) => symbols.filter((symbol) => Object.values(tickers).some((ticker) => ticker.symbol === symbol)).map((symbol) => Object.entries(tickers).find(([, ticker]) => ticker.symbol === symbol)![0]).sort();

describe("shortlistQueries", () => {
  it("the price-data universe is every active entry, Signals on or off; a removed entry is out whatever flags it still carries", async () => {
    const ids = (await activeShortlistTickerIdsQuery()).map((row: { ticker_id: string }) => row.ticker_id);
    expect(mineSorted(ids)).toEqual(["OFF", "OFFPOS", "OFFPREP", "ON"]);
  });

  it("the option universe is active entries with Signals on only; the removed Signals-on entry is out", async () => {
    const ids = (await signalsEnabledShortlistTickerIdsQuery()).map((row: { ticker_id: string }) => row.ticker_id);
    expect(mineSorted(ids)).toEqual(["ON"]);
  });

  it("accepts a transaction as its connection", async () => {
    await testDb.transaction(async (trx) => {
      const ids = (await signalsEnabledShortlistTickerIdsQuery(trx)).map((row: { ticker_id: string }) => row.ticker_id);
      expect(mineSorted(ids)).toEqual(["ON"]);
    });
  });
});

describe("a Signals-off ticker with an open short option", () => {
  it("is still captured nightly (open positions are always in the capture universe)", async () => {
    expect(mineSymbols((await loadCaptureUniverse()).map((ticker) => ticker.symbol))).toEqual(["OFFPOS", "ON"]);
  });

  it("is still scored on Signals for its roll (open short legs are always in the Signals universe)", async () => {
    expect(mineSymbols((await loadSignalsUniverseTickers()).map((ticker) => ticker.symbol))).toEqual(["OFFPOS", "ON"]);
  });

  it("stays in the capture while the option-chain setup started by switching Signals on runs (it was captured before the switch)", async () => {
    const offWithPosition = tickers.OFFPOS!;
    await testDb("shortlist_entries").where({ ticker_id: offWithPosition.id }).whereNull("removed_at").update({ signals_enabled: true });
    const [run] = await testDb("ticker_backfill_runs").insert({ ticker_id: offWithPosition.id, status: "running", steps: JSON.stringify([]), progress_percent: 0 }).returning("id");
    try {
      expect(mineSymbols((await loadCaptureUniverse()).map((ticker) => ticker.symbol))).toEqual(["OFFPOS", "ON"]);
    } finally {
      await testDb("ticker_backfill_runs").where({ id: run.id }).del();
      await testDb("shortlist_entries").where({ ticker_id: offWithPosition.id }).whereNull("removed_at").update({ signals_enabled: false });
    }
  });

  it("a Signals-on ticker with no position is still left out while its setup runs", async () => {
    const [run] = await testDb("ticker_backfill_runs").insert({ ticker_id: tickers.ON!.id, status: "running", steps: JSON.stringify([]), progress_percent: 0 }).returning("id");
    try {
      expect(mineSymbols((await loadCaptureUniverse()).map((ticker) => ticker.symbol))).toEqual(["OFFPOS"]);
    } finally {
      await testDb("ticker_backfill_runs").where({ id: run.id }).del();
    }
  });
});

describe("the stale daily-bar check", () => {
  it("covers Signals-off tickers but skips one still being prepared, and skips removed ones", async () => {
    const inputs = await loadDataInvariantInputs(new Date("2026-10-06T14:00:00Z"), "2026-10-06");
    expect(mineSymbols(Object.keys(inputs.latestBarDateBySymbol))).toEqual(["OFF", "OFFPOS", "ON"]);
  });
});
