import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

// The follower's query and the change it asks for, on real rows: only a person's working orders with Follow the mid ticked
// are followed, and a change is recorded on the payload for the worker. Runs in a private copy of the test tables.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
vi.mock("./platformControls.js", () => ({ fetchTradingHalt: async () => ({ enabled: false, reason: null }) }));

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
const { createManualOrderFollower, loadFollowedManualOrders } = await import("./manualOrderFollowTheMid.js");
const { requestOrderLimitPriceChange } = await import("./orderLimitPriceChangeRequests.js");
const testDb: Knex = db;

const userId = randomUUID();
const putSale = (followTheMid: boolean) => ({
  symbol: "NVDA",
  strategyKey: "cash_secured_put",
  legs: [{ role: "option", action: "SELL", symbol: "NVDA", quantity: 1, unitPrice: 1.5, strike: 180, expiry: "20261120", right: "P" }],
  ...(followTheMid ? { followTheMid: true } : {}),
});
const ids: Record<"followed" | "notTicked" | "filled" | "pluto", string> = { followed: randomUUID(), notTicked: randomUUID(), filled: randomUUID(), pluto: randomUUID() };

beforeAll(async () => {
  await testDb("users").insert({ id: userId, username: "manual-follow", display_name: "Manual Follow", password_hash: "x" });
  const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ test: "manual-follow" }), model_called: false }).returning("id");
  const [action] = await testDb("pluto_actions").insert({ pass_id: pass.id, kind: "open_cash_secured_put", symbol: "NVDA", outcome: "order_built" }).returning("id");
  const row = (id: string, status: string, followTheMid: boolean, plutoActionId: string | null = null) => ({
    id,
    requested_by_user_id: userId,
    request_type: "open_cash_secured_put",
    status,
    ibkr_order_id: Math.floor(Math.random() * 1e6),
    payload: JSON.stringify(putSale(followTheMid)),
    pluto_action_id: plutoActionId,
  });
  await testDb("order_requests").insert([row(ids.followed, "submitted", true), row(ids.notTicked, "submitted", false), row(ids.filled, "filled", true), row(ids.pluto, "submitted", true, action.id)]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("loadFollowedManualOrders", () => {
  it("reads only a person's working orders with Follow the mid ticked", async () => {
    expect((await loadFollowedManualOrders()).map((row) => row.id)).toEqual([ids.followed]);
  });
});

describe("the follower against the database", () => {
  it("records the change on the followed order's payload, one check after its line opens", async () => {
    const follower = createManualOrderFollower({
      loadFollowedOrders: loadFollowedManualOrders,
      subscribe: async () => () => {},
      liveQuote: () => ({ bid: 1.4, ask: 1.46 }),
      requestChange: (orderRequestId, limitPrice) => requestOrderLimitPriceChange(orderRequestId, limitPrice, undefined),
    });
    await follower.check();
    expect((await testDb("order_requests").where({ id: ids.followed }).first()).payload.limitPriceChangeRequest).toBeUndefined();
    await follower.check();
    const followed = await testDb("order_requests").where({ id: ids.followed }).first();
    expect(followed.payload.limitPriceChangeRequest).toEqual({ limitPrice: 1.42, requestedAt: expect.any(String) });
    expect(followed.payload.legs[0].unitPrice).toBe(1.5);
    // Asked again before the worker sent it: nothing new.
    await follower.check();
    expect((await testDb("order_requests").where({ id: ids.followed }).first()).payload.limitPriceChangeRequest).toEqual(followed.payload.limitPriceChangeRequest);
    for (const other of [ids.notTicked, ids.filled, ids.pluto]) {
      expect((await testDb("order_requests").where({ id: other }).first()).payload).not.toHaveProperty("limitPriceChangeRequest");
    }
  });
});
