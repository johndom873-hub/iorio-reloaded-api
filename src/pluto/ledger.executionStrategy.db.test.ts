import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";

// Each Pluto action records the strategy it ran under (the order gates judge a CC + Put Ladder order by it): the ladder,
// Pluto's only strategy since 2026-10-27, whatever an old settings version says. On a private copy of the test tables.
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
  it("is the ladder, for a pass with or without recorded settings", async () => {
    const oldSettingsPass = await startPlutoPass("manual", {}, { executionStrategy: "edge_margin", capitalBudgetPct: 50 });
    const bare = await startPlutoPass("manual");
    expect(await strategyOf(await action(oldSettingsPass))).toBe("cc_put_ladder");
    expect(await strategyOf(await action(bare))).toBe("cc_put_ladder");
  });
});
