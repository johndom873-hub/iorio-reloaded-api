import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real notificationsRouter on a small express app against the test database. The Postgres NOTIFY fan-out (the broadcaster) and
// the notification channel are mocked; presence tracking is the real in-memory tracker and the last-seen stamp is a real write to
// the users table.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run notifications route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

type NotificationListener = (notification: { type: string; [key: string]: unknown }) => void;
const subscribedListeners: NotificationListener[] = [];
const unsubscribeMock = vi.fn();
const subscribeToNotificationsMock = vi.fn((listener: NotificationListener) => {
  subscribedListeners.push(listener);
  return unsubscribeMock;
});
vi.mock("../lib/notificationBroadcaster.js", () => ({ subscribeToNotifications: (listener: NotificationListener) => subscribeToNotificationsMock(listener) }));

const publishNotificationMock = vi.fn();
const fetchRecentNotificationEventsWithOrdersMock = vi.fn();
vi.mock("../lib/notificationChannel.js", () => ({
  publishNotification: (...args: unknown[]) => publishNotificationMock(...args),
  fetchRecentNotificationEventsWithOrders: (...args: unknown[]) => fetchRecentNotificationEventsWithOrdersMock(...args),
}));

const { db } = await import("../db/connection.js");
const { notificationsRouter } = await import("./notifications.js");
const presenceTracker = await import("../lib/presenceTracker.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let userId: string;
let secondUserId: string;
const openStreams: { close: () => void }[] = [];

beforeAll(async () => {
  const inserted = await testDb("users")
    .insert([
      { username: `notif-route-a-${Date.now()}`, display_name: "Notif Route A", password_hash: "not-a-real-hash" },
      { username: `notif-route-b-${Date.now()}`, display_name: "Notif Route B", password_hash: "not-a-real-hash" },
    ])
    .returning("id");
  userId = inserted[0].id;
  secondUserId = inserted[1].id;

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/notifications", notificationsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  subscribedListeners.length = 0;
  unsubscribeMock.mockClear();
  subscribeToNotificationsMock.mockClear();
  publishNotificationMock.mockReset();
  publishNotificationMock.mockResolvedValue(undefined);
  fetchRecentNotificationEventsWithOrdersMock.mockReset();
  await testDb("users").whereIn("id", [userId, secondUserId]).update({ last_seen_at: null });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const stream of openStreams.splice(0)) stream.close();
  await vi.waitFor(() => expect(presenceTracker.onlineUserIds()).not.toContain(userId));
  await vi.waitFor(() => expect(presenceTracker.onlineUserIds()).not.toContain(secondUserId));
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await testDb("users").whereIn("id", [userId, secondUserId]).del();
  await testDb.destroy();
});

/** An open /notifications/stream connection: collects what the server writes, can wait for text and can be closed. */
async function openStream(options: { query?: string; asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? userId : options.asUser;
  const abortController = new AbortController();
  const response = await fetch(`${baseUrl}/notifications/stream${options.query ?? ""}`, { headers: asUser ? { "x-test-user-id": asUser } : {}, signal: abortController.signal });
  const stream = {
    response,
    received: "",
    close: () => abortController.abort(),
    async readUntil(text: string) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      try {
        while (!stream.received.includes(text)) {
          const { value, done } = await reader.read();
          if (done) break;
          stream.received += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
  openStreams.push(stream);
  return stream;
}

const lastSeenAtOf = async (id: string): Promise<Date | null> => (await testDb("users").where({ id }).first("last_seen_at")).last_seen_at;

describe("auth", () => {
  it("GET /notifications/recent is refused without a session", async () => {
    const response = await fetch(`${baseUrl}/notifications/recent`);
    expect(response.status).toBe(401);
    expect(fetchRecentNotificationEventsWithOrdersMock).not.toHaveBeenCalled();
  });

  it("GET /notifications/stream is refused without a session, subscribes to nothing and counts nobody as online", async () => {
    const response = await fetch(`${baseUrl}/notifications/stream`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not logged in." });
    expect(subscribeToNotificationsMock).not.toHaveBeenCalled();
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });
});

describe("GET /notifications/recent", () => {
  it("answers with the thirty most recent events from the channel, wrapped in an events property", async () => {
    const events = [{ id: "e1", notification: { type: "order_status", orderId: "o1" }, order: null }, { id: "e2", notification: { type: "presence", onlineUserIds: [] } }];
    fetchRecentNotificationEventsWithOrdersMock.mockResolvedValue(events);

    const response = await fetch(`${baseUrl}/notifications/recent`, { headers: { "x-test-user-id": userId } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events });
    expect(fetchRecentNotificationEventsWithOrdersMock).toHaveBeenCalledWith(30);
  });

  it("answers with an empty list when nothing has happened yet", async () => {
    fetchRecentNotificationEventsWithOrdersMock.mockResolvedValue([]);
    const response = await fetch(`${baseUrl}/notifications/recent`, { headers: { "x-test-user-id": userId } });
    expect(await response.json()).toEqual({ events: [] });
  });
});

describe("GET /notifications/stream", () => {
  it("opens an event stream", async () => {
    const stream = await openStream();
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.response.headers.get("cache-control")).toBe("no-cache");
    expect(subscribeToNotificationsMock).toHaveBeenCalledTimes(1);
  });

  it("forwards each broadcast notification as one data frame", async () => {
    const stream = await openStream();
    subscribedListeners[0]!({ type: "order_status", orderId: "o-1", status: "filled" });
    subscribedListeners[0]!({ type: "trading_halt_changed", enabled: true });

    await stream.readUntil("trading_halt_changed");

    expect(stream.received).toContain(`data: ${JSON.stringify({ type: "order_status", orderId: "o-1", status: "filled" })}\n\n`);
    expect(stream.received).toContain(`data: ${JSON.stringify({ type: "trading_halt_changed", enabled: true })}\n\n`);
  });

  it("holds back pulse frames unless the connection asked for them with pulses=1", async () => {
    const withoutPulses = await openStream();
    const withPulses = await openStream({ query: "?pulses=1" });
    const withOtherValue = await openStream({ query: "?pulses=true" });
    for (const listener of subscribedListeners) {
      listener({ type: "pulse", edge: "a-b" });
      listener({ type: "marker", note: "after-pulse" });
    }

    await Promise.all([withoutPulses.readUntil("after-pulse"), withPulses.readUntil("after-pulse"), withOtherValue.readUntil("after-pulse")]);

    expect(withoutPulses.received).not.toContain('"type":"pulse"');
    expect(withOtherValue.received).not.toContain('"type":"pulse"');
    expect(withPulses.received).toContain('"type":"pulse"');
  });

  it("marks the user online, stamps their last seen time and publishes the presence frame once the stamp is written", async () => {
    await openStream();

    expect(presenceTracker.onlineUserIds()).toContain(userId);
    await vi.waitFor(() => expect(publishNotificationMock).toHaveBeenCalledTimes(1));
    expect(publishNotificationMock.mock.calls[0]![0]).toEqual({ type: "presence", onlineUserIds: expect.arrayContaining([userId]) });
    expect(await lastSeenAtOf(userId)).toBeInstanceOf(Date);
  });

  it("on disconnect: stops listening, marks the user offline, stamps the last seen time again and publishes the presence frame", async () => {
    const stream = await openStream();
    await vi.waitFor(() => expect(publishNotificationMock).toHaveBeenCalledTimes(1));
    const stampedAtConnect = (await lastSeenAtOf(userId))!;
    publishNotificationMock.mockClear();

    stream.close();

    await vi.waitFor(() => expect(publishNotificationMock).toHaveBeenCalledTimes(1));
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(presenceTracker.onlineUserIds()).not.toContain(userId);
    expect(publishNotificationMock.mock.calls[0]![0].onlineUserIds).not.toContain(userId);
    expect((await lastSeenAtOf(userId))!.getTime()).toBeGreaterThanOrEqual(stampedAtConnect.getTime());
  });

  it("a user with two tabs stays online until the last one closes", async () => {
    const firstTab = await openStream();
    const secondTab = await openStream();
    await vi.waitFor(() => expect(publishNotificationMock).toHaveBeenCalledTimes(2));
    publishNotificationMock.mockClear();

    firstTab.close();
    await vi.waitFor(() => expect(publishNotificationMock).toHaveBeenCalledTimes(1));
    expect(presenceTracker.onlineUserIds()).toContain(userId);
    expect(publishNotificationMock.mock.calls[0]![0].onlineUserIds).toContain(userId);
    publishNotificationMock.mockClear();

    secondTab.close();
    await vi.waitFor(() => expect(publishNotificationMock).toHaveBeenCalledTimes(1));
    expect(presenceTracker.onlineUserIds()).not.toContain(userId);
  });

  it("tracks presence per user: a second user connecting shows both online, and one leaving leaves the other", async () => {
    const first = await openStream();
    await openStream({ asUser: secondUserId });
    await vi.waitFor(() => expect(publishNotificationMock).toHaveBeenCalledTimes(2));
    expect(publishNotificationMock.mock.calls[1]![0].onlineUserIds).toEqual(expect.arrayContaining([userId, secondUserId]));

    first.close();
    await vi.waitFor(() => expect(presenceTracker.onlineUserIds()).not.toContain(userId));
    expect(presenceTracker.onlineUserIds()).toContain(secondUserId);
  });

  it("a last-seen stamp that fails is logged and the presence frame is still published", async () => {
    // Not a uuid, so the users update is rejected by the database.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stream = await openStream({ asUser: "not-a-uuid" });
      await vi.waitFor(() => expect(publishNotificationMock).toHaveBeenCalledTimes(1));
      expect(consoleErrorSpy).toHaveBeenCalledWith("recordUserLastSeen (connect) failed:", expect.any(Error));
      expect(publishNotificationMock.mock.calls[0]![0]).toEqual({ type: "presence", onlineUserIds: expect.arrayContaining(["not-a-uuid"]) });

      stream.close();
      await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith("recordUserLastSeen (disconnect) failed:", expect.any(Error)));
      await vi.waitFor(() => expect(presenceTracker.onlineUserIds()).not.toContain("not-a-uuid"));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("a presence frame that cannot be published does not break the stream", async () => {
    publishNotificationMock.mockRejectedValue(new Error("channel down"));
    const stream = await openStream();
    await vi.waitFor(() => expect(publishNotificationMock).toHaveBeenCalled());

    subscribedListeners[0]!({ type: "marker", note: "still-flowing" });
    await stream.readUntil("still-flowing");

    expect(stream.received).toContain("still-flowing");
  });

  it("sends a comment ping every 20 seconds and stops pinging once the connection is closed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = await openStream();

    vi.advanceTimersByTime(19_999);
    expect(stream.received).not.toContain(": ping");
    vi.advanceTimersByTime(1);
    await stream.readUntil(": ping\n\n");
    expect(stream.received).toContain(": ping\n\n");

    stream.close();
    await vi.waitFor(() => expect(unsubscribeMock).toHaveBeenCalled());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a notification delivered to the listener after the connection ended is ignored without an error, and the listener was unsubscribed", async () => {
    const stream = await openStream();
    stream.close();
    await vi.waitFor(() => expect(unsubscribeMock).toHaveBeenCalledTimes(1));
    expect(() => subscribedListeners[0]!({ type: "marker", note: "late" })).not.toThrow();
  });
});
