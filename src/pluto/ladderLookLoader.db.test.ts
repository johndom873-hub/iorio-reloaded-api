import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../lib/commissionEstimate.js";

// The ladder look's reads against a private copy of the test tables: the ladder's own working orders as sales, and a
// ticker's whole look input. The live stock price is the only thing faked.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
vi.mock("../ibkr/pricePool.js", () => ({ fetchPricesPoolFirst: async () => ({ stock: 51 }) }));

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { loadLadderLookInput, loadWorkingLadderSales } = await import("./ladderLookLoader.js");
const testDb: Knex = db;

const tickerId = randomUUID();
const userId = randomUUID();
const todayIso = "2026-10-20";
const now = new Date("2026-10-20T15:00:00Z");

async function order(executionStrategy: "cc_put_ladder" | "edge_margin", status: string, payload: Record<string, unknown>): Promise<void> {
  const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: "{}", model_called: false }).returning("id");
  const [action] = await testDb("pluto_actions").insert({ pass_id: pass.id, kind: "open_cash_secured_put", symbol: "LOOK", outcome: "confirmed", execution_strategy: executionStrategy }).returning("id");
  await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: payload.strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put", payload: JSON.stringify(payload), status, pluto_action_id: action.id });
}

const putPayload = { symbol: "LOOK", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "LOOK", quantity: 2, unitPrice: 0.8, strike: 45, expiry: "20261120", right: "P" }] };
const coveredCallEntryPayload = { symbol: "LOOK", strategyKey: "covered_call", legs: [{ role: "stock", action: "BUY", symbol: "LOOK", quantity: 300, unitPrice: 50.5 }, { role: "option", action: "SELL", symbol: "LOOK", quantity: 3, unitPrice: 1.1, strike: 55, expiry: "20261120", right: "C" }] };

beforeAll(async () => {
  await testDb("pluto_settings").insert({ id: 1, execution_strategy: "cc_put_ladder" });
  await testDb("users").insert({ id: userId, username: "ladder-look", display_name: "Ladder Look", password_hash: "x" });
  await testDb("tickers").insert({ id: tickerId, symbol: "LOOK", company_name: "Look Co" });
  await testDb("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: userId, signals_enabled: true, bot_enabled: true });
  await testDb("market_calendar").insert(["2026-10-19", "2026-10-20"].map((calendar_date) => ({ calendar_date, is_open: true })));
  await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: "2026-10-19", open_price: 49, high_price: 50.5, low_price: 48.8, close_price: 50, volume: 1_000_000 });
  await testDb("pluto_ticker_settings").insert({ ticker_id: tickerId, ladder_shock_override_pct: 65 });
  await order("cc_put_ladder", "submitted", putPayload);
  await order("cc_put_ladder", "pending_confirmation", coveredCallEntryPayload);
  // Not the ladder's: an Edge Margin order, and a ladder order already filled.
  await order("edge_margin", "submitted", putPayload);
  await order("cc_put_ladder", "filled", putPayload);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("the ladder look's reads", () => {
  it("counts the ladder's own working orders on the ticker as sales, built-not-confirmed included", async () => {
    const sales = await loadWorkingLadderSales("LOOK");
    expect(sales.sort((a, b) => a.strike - b.strike)).toEqual([
      { strategyKey: "cash_secured_put", expiry: "2026-11-20", strike: 45, right: "P", contracts: 2, optionPrice: 0.8, sharesBought: 0, stockPrice: 0 },
      { strategyKey: "covered_call", expiry: "2026-11-20", strike: 55, right: "C", contracts: 3, optionPrice: 1.1, sharesBought: 300, stockPrice: 50.5 },
    ]);
    expect(await loadWorkingLadderSales("OTHER")).toEqual([]);
  });

  it("reads a ticker's whole look: the live price, the previous close, the ticker's shock override and its ladder settings", async () => {
    const input = await loadLadderLookInput({ tickerId, symbol: "LOOK", tickerWeight: 0.25 }, { now, clock: { todayIso, closeMinutesEt: 960, riskFreeRate: 0.04 }, freeCash: 80_000, accountValue: 200_000, commissions: { option: flatCommissionEstimator, stock: flatStockCommissionEstimator }, maxQuoteAgeMinutes: 10 });
    if ("unavailable" in input) throw new Error(input.unavailable);
    expect(input).toMatchObject({ symbol: "LOOK", stockPrice: 51, previousClose: 50, memory: null, shockPctIfStartingToday: 65, bandQuotes: [], previousSessionVolumeByContract: null });
    expect(input).toMatchObject({ maxQuoteAgeMinutes: 10 });
    expect(input.baseline).toMatchObject({ entry: "higher_yield", minCallYieldPct: 20, minCallYieldAppliesTo: "new_covered_calls", ladderRungs: 5, minAbsDelta: 0.05, maxAbsDelta: 0.3 });
    expect(input.book).toMatchObject({ tickerId, freeCash: 80_000, accountValue: 200_000, tickerWeight: 0.25, positions: [], cycleRows: { optionRows: [], stockTradeRows: [], openStockShares: 0 } });
    expect(input.book.workingSales).toHaveLength(2);
  });
});
