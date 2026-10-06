import knexLibrary, { type Knex } from "knex";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Publishing, persistence and the Latest Events read against the real notification_events and order_requests tables of the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the notification channel tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const channel = await import("./notificationChannel.js");
const testDb: Knex = db;

let userId: string;
const createdOrderIds: string[] = [];

async function persistedPayloads(): Promise<unknown[]> {
  return (await testDb("notification_events").orderBy("occurred_at", "asc").select("payload")).map((row) => row.payload);
}

async function insertEvent(payload: unknown, occurredAt: Date) {
  await testDb("notification_events").insert({ payload: JSON.stringify(payload), occurred_at: occurredAt });
}

async function createOrder(status: string, cancellationReason: string | null = null): Promise<string> {
  const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "test", payload: { symbol: "AAA" }, status, cancellation_reason: cancellationReason }).returning(["id"]);
  createdOrderIds.push(order.id);
  return order.id;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeEach(async () => {
  await testDb("notification_events").del();
  if (userId === undefined) {
    const [user] = await testDb("users").insert({ username: `nc_user_${Date.now()}`, display_name: "Notification Test User", password_hash: "x" }).returning(["id"]);
    userId = user.id;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb("notification_events").del();
  await testDb("order_requests").whereIn("id", createdOrderIds).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("publishNotification", () => {
  it("sends the notification on the shared channel and stores it", async () => {
    const rawSpy = vi.spyOn(testDb, "raw");
    await channel.publishNotification({ type: "order_status", orderId: "order-1" });
    expect(rawSpy).toHaveBeenCalledWith("SELECT pg_notify(?, ?)", ["app_notifications_channel", JSON.stringify({ type: "order_status", orderId: "order-1" })]);
    expect(await persistedPayloads()).toEqual([{ type: "order_status", orderId: "order-1" }]);
  });

  it("does not store presence or pulse signals", async () => {
    await channel.publishNotification({ type: "presence", onlineUserIds: ["a"] });
    await channel.publishNotification({ type: "pulse", edgeId: "heroku-db" });
    expect(await persistedPayloads()).toEqual([]);
  });

  it("does not store the ten-minute health check's job events, but stores every other job's", async () => {
    await channel.publishNotification({ type: "job_started", jobName: "ibkr_health_check" });
    await channel.publishNotification({ type: "job_completed", jobName: "ibkr_health_check", status: "success" });
    await channel.publishNotification({ type: "job_completed", jobName: "daily_pnl_snapshot", status: "failure" });
    expect(await persistedPayloads()).toEqual([{ type: "job_completed", jobName: "daily_pnl_snapshot", status: "failure" }]);
  });

  it("keeps only the 200 newest stored events", async () => {
    for (let index = 0; index < 205; index++) await channel.publishNotification({ type: "order_status", orderId: `order-${index}` });
    const payloads = (await persistedPayloads()) as { orderId: string }[];
    expect(payloads).toHaveLength(200);
    expect(payloads[0]!.orderId).toBe("order-5");
    expect(payloads[199]!.orderId).toBe("order-204");
  });
});

describe("fetchRecentNotificationEvents", () => {
  it("returns the newest events first, up to the limit, with an ISO time", async () => {
    await insertEvent({ type: "order_status", orderId: "old" }, minutesAgo(30));
    await insertEvent({ type: "order_status", orderId: "mid" }, minutesAgo(20));
    await insertEvent({ type: "order_status", orderId: "new" }, minutesAgo(10));
    const events = await channel.fetchRecentNotificationEvents(2);
    expect(events.map((event) => (event.notification as { orderId: string }).orderId)).toEqual(["new", "mid"]);
    expect(events[0]!.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("filters the health check out before the limit, so it cannot crowd out real events", async () => {
    await insertEvent({ type: "order_status", orderId: "real" }, minutesAgo(60));
    for (let index = 0; index < 5; index++) await insertEvent({ type: "job_completed", jobName: "ibkr_health_check", status: "success" }, minutesAgo(index + 1));
    await insertEvent({ type: "job_started", jobName: "ibkr_health_check" }, minutesAgo(1));
    const events = await channel.fetchRecentNotificationEvents(3);
    expect(events.map((event) => event.notification)).toEqual([{ type: "order_status", orderId: "real" }]);
  });

  it("returns an empty list when nothing is stored", async () => {
    expect(await channel.fetchRecentNotificationEvents(30)).toEqual([]);
  });
});

describe("fetchRecentNotificationEventsWithOrders", () => {
  it("attaches each order's current status, payload and cancellation reason, and leaves other events alone", async () => {
    const filledOrderId = await createOrder("filled");
    const cancelledOrderId = await createOrder("cancelled", "not_filled_in_time");
    await insertEvent({ type: "order_status", orderId: filledOrderId }, minutesAgo(3));
    await insertEvent({ type: "job_completed", jobName: "daily_pnl_snapshot", status: "success" }, minutesAgo(2));
    await insertEvent({ type: "order_status", orderId: cancelledOrderId }, minutesAgo(1));

    const events = await channel.fetchRecentNotificationEventsWithOrders(10);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ notification: { orderId: cancelledOrderId }, order: { status: "cancelled", payload: { symbol: "AAA" }, cancellationReason: "not_filled_in_time" } });
    expect(events[1]!.notification).toMatchObject({ type: "job_completed" });
    expect("order" in events[1]!).toBe(false);
    expect(events[2]).toMatchObject({ notification: { orderId: filledOrderId }, order: { status: "filled", cancellationReason: null } });
  });

  it("collapses several status changes of one order into its newest event, still returning up to the limit", async () => {
    const orderId = await createOrder("filled");
    await insertEvent({ type: "order_status", orderId }, minutesAgo(30));
    await insertEvent({ type: "order_status", orderId }, minutesAgo(20));
    await insertEvent({ type: "order_status", orderId }, minutesAgo(10));
    await insertEvent({ type: "job_started", jobName: "daily_screener_scan" }, minutesAgo(40));
    await insertEvent({ type: "job_started", jobName: "daily_market_data_capture" }, minutesAgo(50));

    const events = await channel.fetchRecentNotificationEventsWithOrders(3);
    expect(events.map((event) => event.notification.type)).toEqual(["order_status", "job_started", "job_started"]);
    expect(events).toHaveLength(3);
  });

  it("gives a null order when the order no longer exists", async () => {
    await insertEvent({ type: "order_status", orderId: "00000000-0000-0000-0000-000000000000" }, minutesAgo(1));
    const [event] = await channel.fetchRecentNotificationEventsWithOrders(10);
    expect(event!.order).toBeNull();
  });

  it("returns events without any order lookup when none is an order status", async () => {
    await insertEvent({ type: "job_started", jobName: "daily_screener_scan" }, minutesAgo(1));
    const events = await channel.fetchRecentNotificationEventsWithOrders(10);
    expect(events).toHaveLength(1);
    expect("order" in events[0]!).toBe(false);
  });
});

describe("publishPulse", () => {
  it("publishes a pulse, throttles repeats on the same edge to one per 500 ms, and lets another edge through", async () => {
    let now = Date.parse("2031-06-01T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const rawSpy = vi.spyOn(testDb, "raw");
    const publishedPayloads = () => rawSpy.mock.calls.map((call) => String((call[1] as unknown[] | undefined)?.[1] ?? ""));
    const pulseCalls = () => publishedPayloads().filter((payload) => payload.includes('"type":"pulse"')).map((payload) => JSON.parse(payload).edgeId);

    await channel.publishPulse("genosuke-llm");
    now += 100;
    await channel.publishPulse("genosuke-llm");
    await channel.publishPulse("genosuke-db");
    expect(pulseCalls()).toEqual(["genosuke-llm", "genosuke-db"]);

    now += 500;
    await channel.publishPulse("genosuke-llm");
    expect(pulseCalls()).toEqual(["genosuke-llm", "genosuke-db", "genosuke-llm"]);
    expect(await persistedPayloads()).toEqual([]);
  });
});
