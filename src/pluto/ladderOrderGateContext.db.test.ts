import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

// The ladder's order-gate context for an order request, against a private copy of the test tables: null unless the order's
// Pluto action was taken under the ladder; the ticker's pot and delta range, the book (every ticker enabled in Pluto and
// Pluto's capital budget), and whether the order is a Cash-Secured Put entry (its action's sale step). The clock and the
// 10:00 forwards are faked.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
vi.mock("./ladderBandPlanLoader.js", () => ({
  defaultLadderBandPlannerDependencies: {
    loadClock: async (todayIso: string) => ({ todayIso, closeMinutesEt: 960, riskFreeRate: 0.04 }),
    loadForwardAnchors: async () => new Map([["2026-11-20", { forward: 50.2, spotPrice: 50 }]]),
  },
}));

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { loadLadderOrderGateContext } = await import("./ladderOrderGateContext.js");
const testDb: Knex = db;

const userId = randomUUID();
const gateId = randomUUID();
const otherId = randomUUID();
const now = new Date("2026-10-20T15:00:00Z");

async function action(executionStrategy: "cc_put_ladder" | "edge_margin" | "vol_farmer_v2", contract: Record<string, unknown>): Promise<string> {
  const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: "{}", model_called: false }).returning("id");
  const [row] = await testDb("pluto_actions").insert({ pass_id: pass.id, kind: "open_cash_secured_put", symbol: "GATE", outcome: "validated", execution_strategy: executionStrategy, contract: JSON.stringify(contract) }).returning("id");
  return row.id as string;
}

const putPayload = (strike: number) => ({ symbol: "GATE", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "GATE", quantity: 1, unitPrice: 0.8, strike, expiry: "20261120", right: "P" }] }) as never;

beforeAll(async () => {
  await testDb("pluto_settings").insert({ id: 1, execution_strategy: "cc_put_ladder", capital_budget_pct: 40, ladder_min_abs_delta: 0.05, ladder_max_abs_delta: 0.3 });
  await testDb("users").insert({ id: userId, username: "ladder-gate", display_name: "Ladder Gate", password_hash: "x" });
  await testDb("tickers").insert([{ id: gateId, symbol: "GATE", company_name: "Gate Co" }, { id: otherId, symbol: "OTHR", company_name: "Other Co" }]);
  await testDb("shortlist_entries").insert([gateId, otherId].map((ticker_id) => ({ ticker_id, added_by_user_id: userId, bot_enabled: true })));
  await testDb("pluto_ticker_settings").insert({ ticker_id: gateId, ladder_max_abs_delta: 0.25 });
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("loadLadderOrderGateContext", () => {
  it("is null for an order without a Pluto action, or one taken under Edge Margin", async () => {
    expect(await loadLadderOrderGateContext({ pluto_action_id: null, payload: putPayload(45) }, testDb, now)).toBeNull();
    const edgeAction = await action("edge_margin", { strategyKey: "cash_secured_put" });
    expect(await loadLadderOrderGateContext({ pluto_action_id: edgeAction, payload: putPayload(45) }, testDb, now)).toBeNull();
  });

  it("reads the ticker's pot and delta range, the book, the clock and the expiry's forward; a ladder Put is not an entry Put", async () => {
    const ladderPut = await action("cc_put_ladder", { strategyKey: "cash_secured_put", saleStep: "ladder_put" });
    // Two enabled tickers share the budget equally: 50% × 40% = a 20% pot.
    expect(await loadLadderOrderGateContext({ pluto_action_id: ladderPut, payload: putPayload(45) }, testDb, now)).toEqual({
      potFraction: 0.2,
      book: { symbols: ["GATE", "OTHR"], budgetFraction: 0.4 },
      deltaChecked: true,
      isEntryPut: false,
      minAbsDelta: 0.05,
      maxAbsDelta: 0.25,
      forwardAnchor: { forward: 50.2, spotPrice: 50 },
      riskFreeRate: 0.04,
      todayIso: "2026-10-20",
      closeMinutesEt: 960,
    });
  });

  it("tells a Cash-Secured Put entry by its action's sale step; an action from before the step was recorded is a ladder Put", async () => {
    const entryPut = await action("cc_put_ladder", { strategyKey: "cash_secured_put", saleStep: "entry" });
    expect(await loadLadderOrderGateContext({ pluto_action_id: entryPut, payload: putPayload(45) }, testDb, now)).toMatchObject({ isEntryPut: true });
    const older = await action("cc_put_ladder", { strategyKey: "cash_secured_put" });
    expect(await loadLadderOrderGateContext({ pluto_action_id: older, payload: putPayload(45) }, testDb, now)).toMatchObject({ isEntryPut: false });
  });

  it("holds Vol Farmer v2's Puts to |delta| at most its Put |delta| and its Calls to its Calls' range, and gives its LEAPS the book's cap alone", async () => {
    // The migration's defaults: Put |delta| 0.30, the Calls 0.05–0.30.
    const put = await action("vol_farmer_v2", { strategyKey: "cash_secured_put" });
    expect(await loadLadderOrderGateContext({ pluto_action_id: put, payload: putPayload(45) }, testDb, now)).toMatchObject({ potFraction: 0.2, deltaChecked: true, isEntryPut: true, minAbsDelta: 0, maxAbsDelta: 0.3 });
    const call = await action("vol_farmer_v2", { strategyKey: "covered_call" });
    const callPayload = { symbol: "GATE", strategyKey: "covered_call", legs: [{ role: "option", action: "SELL", symbol: "GATE", quantity: 1, unitPrice: 0.8, strike: 55, expiry: "20261120", right: "C" }] } as never;
    expect(await loadLadderOrderGateContext({ pluto_action_id: call, payload: callPayload }, testDb, now)).toMatchObject({ potFraction: 0.2, deltaChecked: true, isEntryPut: false, minAbsDelta: 0.05, maxAbsDelta: 0.3 });
    const leaps = await action("vol_farmer_v2", { strategyKey: "leaps" });
    const leapsPayload = { symbol: "GATE", strategyKey: "leaps", legs: [{ role: "option", action: "BUY", symbol: "GATE", quantity: 1, unitPrice: 12, strike: 40, expiry: "20271217", right: "C" }] } as never;
    expect(await loadLadderOrderGateContext({ pluto_action_id: leaps, payload: leapsPayload }, testDb, now)).toMatchObject({ potFraction: null, deltaChecked: false, book: { symbols: ["GATE", "OTHR"], budgetFraction: 0.4 } });
  });

  it("raises the ticker's pot by the excess allowance; the book's cap stays Pluto's budget", async () => {
    await testDb("pluto_settings").where({ id: 1 }).update({ excess_allowance_pct: 25 });
    try {
      // 50% × (1 + 25%) × 40% = a 25% pot.
      const put = await action("vol_farmer_v2", { strategyKey: "cash_secured_put" });
      expect(await loadLadderOrderGateContext({ pluto_action_id: put, payload: putPayload(45) }, testDb, now)).toMatchObject({ potFraction: 0.25, book: { budgetFraction: 0.4 } });
    } finally {
      await testDb("pluto_settings").where({ id: 1 }).update({ excess_allowance_pct: 0 });
    }
  });
});
