import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";
import type { IBApi } from "@stoqey/ib";
import type { OrderRequestPayload } from "./ibkrGatewayOrderPayload.js";

// The worker's pre-placement price check against the test database: the real settings row and order_requests rows; the IBKR snapshot
// is injected and the app notification replaced.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run limit price check tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
const publishNotificationMock = vi.fn();
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification: async (...args: unknown[]) => publishNotificationMock(...args) }));

const { db } = await import("../db/connection.js");
const { endOrderIfLimitPriceUnsafe } = await import("./ibkrGatewayLimitPriceCheck.js");

const testDb: Knex = db;
let userId: string;
let originalSettings: { price_check_max_deviation_pct: string; price_check_min_tolerance_dollars: string };

const fakeIb = {} as unknown as IBApi;
const putLeg = { role: "option", action: "SELL", symbol: "ZZZP", quantity: 2, unitPrice: 1.35, strike: 50, expiry: "20261016", right: "P" };
const payload = { symbol: "ZZZP", strategyKey: "cash_secured_put", legs: [putLeg] };

async function insertConfirmedOrder(overridePayload: unknown = payload, status = "confirmed") {
  const [row] = await testDb("order_requests")
    .insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify(overridePayload), status })
    .returning(["id", "payload"]);
  return row as { id: string; payload: OrderRequestPayload };
}
const rowOf = (id: string) => testDb("order_requests").where({ id }).first();
const quotes = (...snapshots: { bid: number | null; ask: number | null }[]) => ({ fetchQuotes: async () => ({ quotes: snapshots, notes: [] as string[] }) });

beforeAll(async () => {
  originalSettings = await testDb("trading_settings").first("price_check_max_deviation_pct", "price_check_min_tolerance_dollars");
  const [user] = await testDb("users").insert({ username: `price-check-${Date.now()}`, display_name: "Price Check Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
});

beforeEach(async () => {
  // The leg description counts days to expiry from today's Eastern date: pin it (Date only, so pg keeps its timers).
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T15:00:00Z") });
  publishNotificationMock.mockReset();
  await testDb("order_requests").where({ requested_by_user_id: userId }).del();
  await testDb("trading_settings").update({ price_check_max_deviation_pct: 10, price_check_min_tolerance_dollars: 0.05 });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await testDb("order_requests").where({ requested_by_user_id: userId }).del();
  await testDb("trading_settings").update(originalSettings);
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("endOrderIfLimitPriceUnsafe", () => {
  it("lets an order priced near the live mid through and touches nothing", async () => {
    const order = await insertConfirmedOrder();
    expect(await endOrderIfLimitPriceUnsafe(order, fakeIb, quotes({ bid: 1.3, ask: 1.4 }))).toBeNull();
    expect((await rowOf(order.id)).status).toBe("confirmed");
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });

  it("ends an order whose limit is far worse than the live mid, with the figures in the error and an app notification", async () => {
    const order = await insertConfirmedOrder();
    const result = await endOrderIfLimitPriceUnsafe(order, fakeIb, quotes({ bid: 3.9, ask: 4.1 }));
    expect(result).toMatchObject({ ended: true });
    expect(result!.reason).toContain("failed the live-quote check at placement");
    expect(result!.reason).toContain("for ZZZP Sell $50 Put · 16 Oct (9DTE) · 2× is");
    expect(result!.reason).toContain("below the live mid 4.00");
    const row = await rowOf(order.id);
    expect(row.status).toBe("error");
    expect(row.error_message).toBe(result!.reason);
    expect(publishNotificationMock).toHaveBeenCalledWith({ type: "order_status", orderId: order.id });
  });

  it("ends an order with no usable quote (fail closed) and passes on IBKR's explanation", async () => {
    const order = await insertConfirmedOrder();
    const result = await endOrderIfLimitPriceUnsafe(order, fakeIb, {
      fetchQuotes: async () => ({ quotes: [{ bid: null, ask: null }], notes: ["IBKR error 354 for leg 1: Requested market data is not subscribed"] }),
    });
    expect(result!.reason).toContain("No live two-sided quote");
    expect(result!.reason).toContain("IBKR error 354 for leg 1");
    expect((await rowOf(order.id)).status).toBe("error");
  });

  it("ends the order, rather than placing it, when the snapshot itself fails", async () => {
    const order = await insertConfirmedOrder();
    const result = await endOrderIfLimitPriceUnsafe(order, fakeIb, {
      fetchQuotes: async () => {
        throw new Error("not connected");
      },
    });
    expect(result!.reason).toBe("The order's limit price could not be checked against a live quote at placement (not connected).");
    expect((await rowOf(order.id)).status).toBe("error");
  });

  it("uses the tolerance saved on Risk & Limits: a looser setting lets the same order through, a zero setting refuses a hair off the mid", async () => {
    const order = await insertConfirmedOrder();
    const market = quotes({ bid: 1.95, ask: 2.05 }); // mid 2.00; the order sells at 1.35, 0.65 below
    await testDb("trading_settings").update({ price_check_max_deviation_pct: 40 }); // allows 0.80
    expect(await endOrderIfLimitPriceUnsafe(order, fakeIb, market)).toBeNull();
    await testDb("trading_settings").update({ price_check_max_deviation_pct: 10 }); // allows 0.20
    expect((await endOrderIfLimitPriceUnsafe(order, fakeIb, market))?.ended).toBe(true);
  });

  it("checks every leg of a combo and ends the order for the one that is off", async () => {
    const combo = { symbol: "ZZZP", strategyKey: "covered_call", legs: [{ role: "stock", action: "BUY", symbol: "ZZZP", quantity: 200, unitPrice: 48.2 }, { ...putLeg, right: "C", strike: 55, unitPrice: 0.11 }] };
    const order = await insertConfirmedOrder(combo);
    const result = await endOrderIfLimitPriceUnsafe(order, fakeIb, quotes({ bid: 48.15, ask: 48.25 }, { bid: 1.05, ask: 1.15 }));
    expect(result!.reason).toContain("for ZZZP Sell $55 Call · 16 Oct (9DTE) · 2× is");
    expect(result!.reason).not.toContain("ZZZP Buy 200 shares");
  });

  it("a cancel that landed first keeps its status: the block is reported but nothing is ended or announced", async () => {
    const order = await insertConfirmedOrder();
    await testDb("order_requests").where({ id: order.id }).update({ status: "cancelled" });
    const result = await endOrderIfLimitPriceUnsafe(order, fakeIb, quotes({ bid: 3.9, ask: 4.1 }));
    expect(result).toMatchObject({ ended: false });
    const row = await rowOf(order.id);
    expect(row.status).toBe("cancelled");
    expect(row.error_message).toBeNull();
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });

  it("has nothing to check for an order without legs, and does not ask IBKR", async () => {
    const order = await insertConfirmedOrder({ symbol: "ZZZP", strategyKey: "cash_secured_put", legs: [] });
    const fetchQuotes = vi.fn();
    expect(await endOrderIfLimitPriceUnsafe(order, fakeIb, { fetchQuotes })).toBeNull();
    expect(fetchQuotes).not.toHaveBeenCalled();
  });
});
