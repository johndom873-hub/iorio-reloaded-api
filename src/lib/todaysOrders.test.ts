import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

// The pure matching runs without a database; the day filter runs against the test database (same convention as expirySettlementAuditDatabase.test.ts).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run today's-orders tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { buildTodaysOrders, fetchTodaysOrders } = await import("./todaysOrders.js");

const testDb: Knex = db;

const rollPayload: OrderRequestPayload = {
  symbol: "ROLL",
  strategyKey: "covered_call",
  adaptivePriority: "Patient",
  legs: [
    { role: "option", action: "BUY" as never, symbol: "ROLL", quantity: 2, unitPrice: 1.5, strike: 50, expiry: "20261016", right: "C" },
    { role: "option", action: "SELL" as never, symbol: "ROLL", quantity: 2, unitPrice: 2.25, strike: 50, expiry: "20261023", right: "C" },
  ],
};

function orderRow(id: string, payload: OrderRequestPayload, status = "filled") {
  return {
    id,
    request_type: "roll_leg",
    status,
    payload,
    created_at: new Date("2026-10-01T14:00:00Z"),
    updated_at: new Date("2026-10-01T14:05:00Z"),
    requested_by_display_name: "Marce",
    cancelled_by_display_name: null,
    cancellation_reason: null,
    error_message: null,
    ibkr_order_id: 7,
    ibkr_perm_id: 99,
  };
}

describe("buildTodaysOrders", () => {
  it("matches each leg of a roll to its own fills even though both are option legs on the same strike", () => {
    const [order] = buildTodaysOrders(
      [orderRow("a", rollPayload)],
      [
        { orderRequestId: "a", legType: "option", side: "buy", strike: "50.0000", expiry: "20261016", quantity: "2", notional: "3.04", commission: "1.3" },
        { orderRequestId: "a", legType: "option", side: "sell", strike: "50.0000", expiry: "20261023", quantity: "2", notional: "4.5", commission: "1.3" },
      ],
    );
    expect(order!.legs[0]).toMatchObject({ action: "BUY", filledQuantity: 2, averageFillPrice: 1.52 });
    expect(order!.legs[1]).toMatchObject({ action: "SELL", filledQuantity: 2, averageFillPrice: 2.25 });
    expect(order!.commission).toBeCloseTo(2.6);
    expect(order!.netLimitPrice).toBeCloseTo(-0.75);
    expect(order!.adaptivePriority).toBe("Patient");
  });

  it("reads a close or roll leg whose payload expiry is an ISO timestamp the same as a YYYYMMDD one", () => {
    const payload: OrderRequestPayload = {
      symbol: "ISO",
      strategyKey: "covered_call",
      legs: [{ role: "option", action: "BUY" as never, symbol: "ISO", quantity: 3, unitPrice: 1.2, strike: 103, expiry: "2026-10-02T00:00:00.000Z", right: "C" }],
    };
    const [order] = buildTodaysOrders(
      [orderRow("d", payload)],
      [{ orderRequestId: "d", legType: "option", side: "buy", strike: "103.0000", expiry: "20261002", quantity: 3, notional: 3.6, commission: 1 }],
    );
    expect(order!.legs[0]).toMatchObject({ expiry: "20261002", filledQuantity: 3, averageFillPrice: 1.2 });
  });

  it("weights the average fill price by quantity across several executions of one leg", () => {
    const [order] = buildTodaysOrders(
      [orderRow("b", { symbol: "BW", strategyKey: "covered_call", legs: [{ role: "stock", action: "BUY" as never, symbol: "BW", quantity: 100, unitPrice: 10 }] })],
      [{ orderRequestId: "b", legType: "stock", side: "buy", strike: null, expiry: null, quantity: 100, notional: 100 * 10 - 10, commission: null }],
    );
    expect(order!.legs[0]).toMatchObject({ filledQuantity: 100, averageFillPrice: 9.9 });
    expect(order!.commission).toBeNull();
  });

  it("leaves a leg with no fills at zero filled with no average price", () => {
    const [order] = buildTodaysOrders([orderRow("c", rollPayload, "submitted")], []);
    expect(order!.legs.every((leg) => leg.filledQuantity === 0 && leg.averageFillPrice === null)).toBe(true);
    expect(order!.commission).toBeNull();
  });
});

describe("fetchTodaysOrders", () => {
  const createdOrderIds: string[] = [];
  let userId: string;

  async function insertOrder(status: string, updatedAt: Date): Promise<string> {
    userId ??= (await testDb("users").first("id")).id;
    const [row] = await testDb("order_requests")
      .insert({
        requested_by_user_id: userId,
        request_type: "open_covered_call",
        payload: JSON.stringify({ symbol: "TODAYTEST", strategyKey: "covered_call", legs: [] }),
        status,
        updated_at: updatedAt,
      })
      .returning(["id"]);
    createdOrderIds.push(row.id);
    return row.id;
  }

  afterAll(async () => {
    await testDb("order_requests").whereIn("id", createdOrderIds).delete();
    await testDb.destroy();
  });

  it("uses the New York calendar day, not UTC, and still lists active orders from an earlier day", async () => {
    // 2026-10-02 02:00 UTC is still the evening of 2026-10-01 in New York (EDT, UTC-4).
    const now = new Date("2026-10-02T02:00:00Z");
    const eveningToday = await insertOrder("filled", new Date("2026-10-02T01:30:00Z")); // 21:30 ET on 10-01 -> today
    const justBeforeMidnightEt = await insertOrder("cancelled", new Date("2026-10-01T04:00:00Z")); // 00:00 ET on 10-01 -> today
    const lastSecondOfYesterdayEt = await insertOrder("filled", new Date("2026-10-01T03:59:59Z")); // 23:59:59 ET on 09-30 -> yesterday
    const oldAndFinished = await insertOrder("error", new Date("2026-09-25T15:00:00Z"));
    const oldButStillWorking = await insertOrder("submitted", new Date("2026-09-30T23:00:00Z"));

    // The test database is shared with other rows, so look only at the ones this test created.
    const listedIds = (await fetchTodaysOrders(now)).map((order) => order.id).filter((id) => createdOrderIds.includes(id));
    expect(new Set(listedIds)).toEqual(new Set([eveningToday, justBeforeMidnightEt, oldButStillWorking]));
    expect(listedIds).not.toContain(lastSecondOfYesterdayEt);
    expect(listedIds).not.toContain(oldAndFinished);
    // Newest update first.
    expect(listedIds[0]).toBe(eveningToday);
  });

  it("accepts the new cancelled_partially_filled status", async () => {
    const id = await insertOrder("cancelled_partially_filled", new Date());
    expect((await fetchTodaysOrders()).find((order) => order.id === id)?.status).toBe("cancelled_partially_filled");
  });
});
