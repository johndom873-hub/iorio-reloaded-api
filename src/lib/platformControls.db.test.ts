import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// The real trading-halt store and the real trading gate against the test database (nothing mocked but the connection).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run platform controls tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { fetchTradingHalt, setTradingHalt, describeTradingHaltBlock, tradingHaltControlKey } = await import("./platformControls.js");
const { fetchTradingBlockedReason } = await import("./tradingGate.js");

const testDb: Knex = db;
let userId: string;
let originalRow: Record<string, unknown> | undefined;

beforeAll(async () => {
  originalRow = await testDb("platform_controls").where({ key: tradingHaltControlKey }).first();
  const [user] = await testDb("users").insert({ username: `halt-${Date.now()}`, display_name: "Halt Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
});

beforeEach(async () => {
  await testDb("platform_controls").insert({ key: tradingHaltControlKey, enabled: false, reason: null, set_by_user_id: null }).onConflict("key").merge({ enabled: false, reason: null, set_by_user_id: null });
});

afterAll(async () => {
  if (originalRow) await testDb("platform_controls").insert(originalRow).onConflict("key").merge();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("the trading halt store", () => {
  it("is seeded off", async () => {
    const halt = await fetchTradingHalt();
    expect(halt.enabled).toBe(false);
    expect(describeTradingHaltBlock(halt)).toBeNull();
  });

  it("stores who, when and why, and reads them back", async () => {
    const written = await setTradingHalt({ enabled: true, reason: "testing the switch", userId });
    expect(written.enabled).toBe(true);
    expect(written.reason).toBe("testing the switch");
    expect(written.setByDisplayName).toBe("Halt Tester");
    const row = await testDb("platform_controls").where({ key: tradingHaltControlKey }).first();
    expect(row).toMatchObject({ enabled: true, reason: "testing the switch", set_by_user_id: userId });
    expect((await fetchTradingHalt()).setAt).toBeInstanceOf(Date);
    expect(describeTradingHaltBlock(await fetchTradingHalt())).toMatch(/^Trading is halted — switched off by Halt Tester .*: testing the switch$/);
  });

  it("lifting it clears the block", async () => {
    await setTradingHalt({ enabled: true, reason: "x", userId });
    const lifted = await setTradingHalt({ enabled: false, reason: null, userId });
    expect(lifted.enabled).toBe(false);
    expect(describeTradingHaltBlock(lifted)).toBeNull();
  });

  it("fails closed when the row is missing: the switch's state cannot be known", async () => {
    await testDb("platform_controls").where({ key: tradingHaltControlKey }).del();
    const halt = await fetchTradingHalt();
    expect(halt.enabled).toBe(true);
    expect(describeTradingHaltBlock(halt)).toContain("missing from platform_controls");
  });
});

describe("the real trading gate reads the halt from the database", () => {
  it("reports the halt reason first, ahead of any worker problem, and clears when lifted", async () => {
    await setTradingHalt({ enabled: true, reason: "gate test", userId });
    expect(await fetchTradingBlockedReason()).toMatch(/^Trading is halted — switched off by Halt Tester .*: gate test$/);
    await setTradingHalt({ enabled: false, reason: null, userId });
    const reasonWhenLifted = await fetchTradingBlockedReason();
    expect(reasonWhenLifted === null || !reasonWhenLifted.startsWith("Trading is halted")).toBe(true);
  });
});
