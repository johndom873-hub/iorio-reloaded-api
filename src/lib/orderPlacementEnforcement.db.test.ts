import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// The worker's pre-placement step against the test database: the real halt row, the real order_requests rows. Only the connection and
// the outbound app notification are replaced.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run order placement enforcement tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
const publishNotificationMock = vi.fn();
vi.mock("./notificationChannel.js", () => ({ publishNotification: async (...args: unknown[]) => publishNotificationMock(...args) }));

const { db } = await import("../db/connection.js");
const { endOrderIfPlacementBlocked } = await import("./orderPlacementEnforcement.js");
const { maximumConfirmedOrderAgeMs } = await import("./orderPlacementGuard.js");
const { tradingHaltControlKey } = await import("./platformControls.js");

const testDb: Knex = db;
let userId: string;
let originalHaltRow: Record<string, unknown> | undefined;

const payload = { symbol: "ZZZT", strategyKey: "cash_secured_put", legs: [{ role: "option", right: "P", action: "SELL", expiry: "20261120", strike: 50, symbol: "ZZZT", quantity: 1, unitPrice: 1 }] };
const verdictAt = (ageMs: number, blocks: string[] = []) => ({ blocks, warnings: [], evaluatedAt: new Date(Date.now() - ageMs).toISOString() });

async function insertConfirmedOrder(gateEvaluation: unknown, status = "confirmed"): Promise<string> {
  const [row] = await testDb("order_requests")
    .insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify(payload), status, gate_evaluation: gateEvaluation === null ? null : JSON.stringify(gateEvaluation) })
    .returning("id");
  return row.id;
}
const rowOf = (id: string) => testDb("order_requests").where({ id }).first();
const callGuard = async (id: string) => endOrderIfPlacementBlocked(await rowOf(id));
const setHalt = (enabled: boolean, reason: string | null = null) => testDb("platform_controls").where({ key: tradingHaltControlKey }).update({ enabled, reason, set_by_user_id: userId });

beforeAll(async () => {
  originalHaltRow = await testDb("platform_controls").where({ key: tradingHaltControlKey }).first();
  const [user] = await testDb("users").insert({ username: `placement-${Date.now()}`, display_name: "Placement Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
});

beforeEach(async () => {
  publishNotificationMock.mockReset();
  await testDb("order_requests").where({ requested_by_user_id: userId }).del();
  await testDb("platform_controls").insert({ key: tradingHaltControlKey, enabled: false, reason: null, set_by_user_id: null }).onConflict("key").merge({ enabled: false, reason: null, set_by_user_id: null });
});

afterAll(async () => {
  await testDb("order_requests").where({ requested_by_user_id: userId }).del();
  if (originalHaltRow) await testDb("platform_controls").insert(originalHaltRow).onConflict("key").merge();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("endOrderIfPlacementBlocked", () => {
  it("lets a freshly gated order through and touches nothing", async () => {
    const id = await insertConfirmedOrder(verdictAt(10_000));
    expect(await callGuard(id)).toBeNull();
    expect((await rowOf(id)).status).toBe("confirmed");
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });

  it("ends a confirmed order as an error while trading is halted, and says who and why", async () => {
    const id = await insertConfirmedOrder(verdictAt(10_000));
    await setHalt(true, "worker test");
    const result = await callGuard(id);
    expect(result).toMatchObject({ ended: true });
    expect(result?.reason).toMatch(/^Trading is halted — switched off by Placement Tester .*: worker test$/);
    const row = await rowOf(id);
    expect(row.status).toBe("error");
    expect(row.error_message).toBe(result?.reason);
    expect(publishNotificationMock).toHaveBeenCalledWith({ type: "order_status", orderId: id });
  });

  it("a halt that is lifted later does not revive the order that was ended", async () => {
    const id = await insertConfirmedOrder(verdictAt(10_000));
    await setHalt(true, "x");
    await callGuard(id);
    await setHalt(false);
    expect((await rowOf(id)).status).toBe("error");
    expect(await testDb("order_requests").where({ id, status: "confirmed" }).first()).toBeUndefined();
  });

  it("ends an order that has no stored gate verdict", async () => {
    const id = await insertConfirmedOrder(null);
    const result = await callGuard(id);
    expect(result?.reason).toContain("no stored gate verdict");
    expect((await rowOf(id)).status).toBe("error");
  });

  it("ends an order whose verdict recorded blocks", async () => {
    const id = await insertConfirmedOrder(verdictAt(10_000, ["ZZZT would be 25.0% of portfolio value."]));
    expect((await callGuard(id))?.reason).toContain("ZZZT would be 25.0% of portfolio value.");
    expect((await rowOf(id)).status).toBe("error");
  });

  it("ends an order that waited longer than the maximum age, with the expiry wording", async () => {
    const id = await insertConfirmedOrder(verdictAt(maximumConfirmedOrderAgeMs + 60_000));
    const result = await callGuard(id);
    expect(result?.reason).toContain("expired");
    expect((await rowOf(id)).error_message).toBe(result?.reason);
    expect((await rowOf(id)).status).toBe("error");
  });

  it("an order just inside the maximum age is still placed", async () => {
    const id = await insertConfirmedOrder(verdictAt(maximumConfirmedOrderAgeMs - 30_000));
    expect(await callGuard(id)).toBeNull();
  });

  it("a cancel that landed first keeps its status: the block is reported but nothing is ended or announced", async () => {
    const id = await insertConfirmedOrder(verdictAt(10_000));
    const row = await rowOf(id);
    await testDb("order_requests").where({ id }).update({ status: "cancelled" });
    await setHalt(true, "x");
    const result = await endOrderIfPlacementBlocked(row);
    expect(result).toMatchObject({ ended: false });
    expect((await rowOf(id)).status).toBe("cancelled");
    expect((await rowOf(id)).error_message).toBeNull();
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });

  it("fails closed when the halt row is missing", async () => {
    const id = await insertConfirmedOrder(verdictAt(10_000));
    await testDb("platform_controls").where({ key: tradingHaltControlKey }).del();
    const result = await callGuard(id);
    expect(result?.reason).toContain("missing from platform_controls");
    expect((await rowOf(id)).status).toBe("error");
  });
});
