import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";

// Each Pluto action records the strategy its pass ran under (the settings version of the pass), else today's: the order
// gates judge a CC + Put Ladder order by it. On a private copy of the test tables.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { recordPlutoAction, startPlutoPass } = await import("./ledger.js");
const testDb: Knex = db;

beforeAll(async () => {
  await testDb("pluto_settings").insert({ id: 1 });
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

const action = (passId: string) => recordPlutoAction({ passId, kind: "open_cash_secured_put", symbol: "LADR", tickerId: null, contract: null, candidateScores: null, deterministicTopPick: null, gateResults: [], sizeTier: null, quantity: 1, limitPrice: 1.2, outcome: "validated", blockReason: null, referenceBid: 1.1, referenceMid: 1.2 });
const strategyOf = async (actionId: string) => (await testDb("pluto_actions").where({ id: actionId }).first("execution_strategy")).execution_strategy;

describe("recordPlutoAction's execution strategy", () => {
  it("is the strategy of the settings the action's pass ran under, even after a switch", async () => {
    const ladderPass = await startPlutoPass("manual", {}, { executionStrategy: "cc_put_ladder", capitalBudgetPct: 50 });
    const edgePass = await startPlutoPass("manual", {}, { executionStrategy: "edge_margin", capitalBudgetPct: 50 });
    expect(await strategyOf(await action(ladderPass))).toBe("cc_put_ladder");
    expect(await strategyOf(await action(edgePass))).toBe("edge_margin");
  });

  it("falls back to today's strategy for a pass that recorded no settings", async () => {
    const bare = await startPlutoPass("manual");
    expect(await strategyOf(await action(bare))).toBe("edge_margin");
    await testDb("pluto_settings").where({ id: 1 }).update({ execution_strategy: "cc_put_ladder" });
    expect(await strategyOf(await action(bare))).toBe("cc_put_ladder");
  });
});
