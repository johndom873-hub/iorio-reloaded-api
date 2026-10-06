import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppNotification } from "./notificationChannel.js";

const fakePgState = vi.hoisted(() => {
  class FakePgClient {
    static instances: FakePgClient[] = [];
    static connectBehaviours: Array<() => Promise<void>> = [];
    static queryBehaviour: (sql: string) => Promise<unknown> = async () => undefined;

    readonly options: unknown;
    readonly handlers = new Map<string, (argument: unknown) => void>();
    readonly queries: string[] = [];
    endCallCount = 0;
    endBehaviour: () => Promise<void> = async () => {};

    constructor(options: unknown) {
      this.options = options;
      FakePgClient.instances.push(this);
    }

    on(eventName: string, handler: (argument: unknown) => void) {
      this.handlers.set(eventName, handler);
      return this;
    }

    async connect() {
      const behaviour = FakePgClient.connectBehaviours.shift();
      if (behaviour) await behaviour();
    }

    async query(sql: string) {
      this.queries.push(sql);
      return FakePgClient.queryBehaviour(sql);
    }

    end() {
      this.endCallCount++;
      return this.endBehaviour();
    }

    emit(eventName: string, argument: unknown) {
      this.handlers.get(eventName)!(argument);
    }
  }
  return { FakePgClient };
});
const { FakePgClient } = fakePgState;

vi.mock("pg", () => ({ Client: fakePgState.FakePgClient }));
vi.mock("../config/env.js", () => ({ environment: { databaseUrl: "postgres://test-user@localhost/test-db" } }));
vi.mock("../config/databaseSsl.js", () => ({ postgresSslOption: () => ({ rejectUnauthorized: false }) }));
vi.mock("./notificationChannel.js", () => ({ appNotificationsChannel: "app_notifications_channel" }));

const { broadcastToLocalSubscribers, startNotificationBroadcaster, subscribeToNotifications } = await import("./notificationBroadcaster.js");

const orderNotification: AppNotification = { type: "order_status", orderId: "order-1" };
const positionNotification: AppNotification = { type: "position_opened", positionId: "position-1", symbol: "AAPL" };

let unsubscribeCallbacks: Array<() => void> = [];

function subscribe(subscriber: (notification: AppNotification) => void) {
  const unsubscribe = subscribeToNotifications(subscriber);
  unsubscribeCallbacks.push(unsubscribe);
  return unsubscribe;
}

function latestClient() {
  return FakePgClient.instances.at(-1)!;
}

beforeEach(() => {
  FakePgClient.instances = [];
  FakePgClient.connectBehaviours = [];
  FakePgClient.queryBehaviour = async () => undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  unsubscribeCallbacks.forEach((unsubscribe) => unsubscribe());
  unsubscribeCallbacks = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subscribeToNotifications and broadcastToLocalSubscribers", () => {
  it("delivers a notification to every subscriber", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribe(first);
    subscribe(second);
    broadcastToLocalSubscribers(orderNotification);
    expect(first).toHaveBeenCalledExactlyOnceWith(orderNotification);
    expect(second).toHaveBeenCalledExactlyOnceWith(orderNotification);
  });

  it("does nothing when there are no subscribers", () => {
    expect(() => broadcastToLocalSubscribers(orderNotification)).not.toThrow();
  });

  it("stops delivering to a subscriber after it unsubscribes, and leaves the others subscribed", () => {
    const stays = vi.fn();
    const leaves = vi.fn();
    subscribe(stays);
    const unsubscribe = subscribe(leaves);
    broadcastToLocalSubscribers(orderNotification);
    unsubscribe();
    broadcastToLocalSubscribers(positionNotification);
    expect(leaves).toHaveBeenCalledTimes(1);
    expect(stays).toHaveBeenCalledTimes(2);
  });

  it("makes the unsubscribe function idempotent", () => {
    const subscriber = vi.fn();
    const unsubscribe = subscribe(subscriber);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    broadcastToLocalSubscribers(orderNotification);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("registers the same function only once", () => {
    const subscriber = vi.fn();
    subscribe(subscriber);
    subscribe(subscriber);
    broadcastToLocalSubscribers(orderNotification);
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it("delivers in subscription order", () => {
    const order: string[] = [];
    subscribe(() => order.push("first"));
    subscribe(() => order.push("second"));
    broadcastToLocalSubscribers(orderNotification);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("startNotificationBroadcaster", () => {
  it("opens a dedicated connection with the database url and ssl option, then LISTENs on the notifications channel", async () => {
    startNotificationBroadcaster();
    await vi.waitFor(() => expect(latestClient().queries).toEqual(["LISTEN app_notifications_channel"]));
    expect(FakePgClient.instances).toHaveLength(1);
    expect(latestClient().options).toEqual({ connectionString: "postgres://test-user@localhost/test-db", ssl: { rejectUnauthorized: false } });
    expect(console.log).toHaveBeenCalledWith("notificationBroadcaster: listening for app notifications.");
  });

  describe("notification handling", () => {
    async function startAndGetClient() {
      startNotificationBroadcaster();
      await vi.waitFor(() => expect(latestClient().queries).toHaveLength(1));
      return latestClient();
    }

    it("parses a payload on the app channel and fans it out to subscribers", async () => {
      const subscriber = vi.fn();
      subscribe(subscriber);
      const client = await startAndGetClient();
      client.emit("notification", { channel: "app_notifications_channel", payload: JSON.stringify(positionNotification) });
      expect(subscriber).toHaveBeenCalledExactlyOnceWith(positionNotification);
    });

    it("ignores notifications from other channels", async () => {
      const subscriber = vi.fn();
      subscribe(subscriber);
      const client = await startAndGetClient();
      client.emit("notification", { channel: "order_requests_channel", payload: JSON.stringify(orderNotification) });
      expect(subscriber).not.toHaveBeenCalled();
    });

    it("ignores notifications with no payload", async () => {
      const subscriber = vi.fn();
      subscribe(subscriber);
      const client = await startAndGetClient();
      client.emit("notification", { channel: "app_notifications_channel", payload: undefined });
      client.emit("notification", { channel: "app_notifications_channel", payload: "" });
      expect(subscriber).not.toHaveBeenCalled();
    });

    it("drops a malformed JSON payload without throwing and keeps delivering later ones", async () => {
      const subscriber = vi.fn();
      subscribe(subscriber);
      const client = await startAndGetClient();
      expect(() => client.emit("notification", { channel: "app_notifications_channel", payload: "{not json" })).not.toThrow();
      expect(subscriber).not.toHaveBeenCalled();
      client.emit("notification", { channel: "app_notifications_channel", payload: JSON.stringify(orderNotification) });
      expect(subscriber).toHaveBeenCalledExactlyOnceWith(orderNotification);
    });

    it("does not deliver to a subscriber that unsubscribed", async () => {
      const subscriber = vi.fn();
      const unsubscribe = subscribe(subscriber);
      const client = await startAndGetClient();
      unsubscribe();
      client.emit("notification", { channel: "app_notifications_channel", payload: JSON.stringify(orderNotification) });
      expect(subscriber).not.toHaveBeenCalled();
    });
  });

  describe("reconnecting after a connection error", () => {
    async function startAndGetClient() {
      startNotificationBroadcaster();
      await vi.waitFor(() => expect(latestClient().queries).toHaveLength(1));
      return latestClient();
    }

    it("logs the error, ends the dead client and reconnects with a new client after 1 second", async () => {
      vi.useFakeTimers();
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);
      const firstClient = latestClient();

      firstClient.emit("error", new Error("terminating connection"));
      expect(console.error).toHaveBeenCalledWith("notificationBroadcaster: LISTEN connection error: terminating connection");
      expect(firstClient.endCallCount).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(FakePgClient.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakePgClient.instances).toHaveLength(2);
      expect(latestClient()).not.toBe(firstClient);
      expect(latestClient().queries).toEqual(["LISTEN app_notifications_channel"]);
    });

    it("swallows a failure while ending the dead client", async () => {
      vi.useFakeTimers();
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);
      const firstClient = latestClient();
      firstClient.endBehaviour = async () => {
        throw new Error("already closed");
      };

      firstClient.emit("error", new Error("boom"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakePgClient.instances).toHaveLength(2);
    });

    it("delivers notifications from the replacement client to existing subscribers", async () => {
      vi.useFakeTimers();
      const subscriber = vi.fn();
      subscribe(subscriber);
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);
      latestClient().emit("error", new Error("boom"));
      await vi.advanceTimersByTimeAsync(1_000);

      latestClient().emit("notification", { channel: "app_notifications_channel", payload: JSON.stringify(orderNotification) });
      expect(subscriber).toHaveBeenCalledExactlyOnceWith(orderNotification);
    });
  });

  describe("retrying after a failed connect", () => {
    function failConnectTimes(count: number) {
      for (let i = 0; i < count; i++) {
        FakePgClient.connectBehaviours.push(async () => {
          throw new Error("ECONNREFUSED");
        });
      }
    }

    it("logs the failure and retries after 1 second", async () => {
      vi.useFakeTimers();
      failConnectTimes(1);
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);

      expect(console.error).toHaveBeenCalledWith("notificationBroadcaster: failed to connect: ECONNREFUSED");
      expect(FakePgClient.instances).toHaveLength(1);
      expect(latestClient().queries).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakePgClient.instances).toHaveLength(2);
      expect(latestClient().queries).toEqual(["LISTEN app_notifications_channel"]);
    });

    it("backs off 1s, 2s, 5s, 10s, 30s and then stays at 30s", async () => {
      vi.useFakeTimers();
      failConnectTimes(7);
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);

      const expectedDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000];
      for (const [index, delay] of expectedDelaysMs.entries()) {
        const clientsBeforeDelay = FakePgClient.instances.length;
        expect(clientsBeforeDelay).toBe(index + 1);
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(FakePgClient.instances).toHaveLength(clientsBeforeDelay);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakePgClient.instances).toHaveLength(clientsBeforeDelay + 1);
      }
    });

    it("retries when the LISTEN query itself fails, and logs a non-Error reason as text", async () => {
      vi.useFakeTimers();
      let queryCallCount = 0;
      FakePgClient.queryBehaviour = async () => {
        if (queryCallCount++ === 0) throw "permission denied";
      };
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);
      expect(console.error).toHaveBeenCalledWith("notificationBroadcaster: failed to connect: permission denied");
      expect(console.log).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(console.log).toHaveBeenCalledWith("notificationBroadcaster: listening for app notifications.");
    });
  });
  describe("one replacement per dead connection, and a fresh backoff after a working one", () => {
    function failConnectTimes(count: number) {
      for (let i = 0; i < count; i++) {
        FakePgClient.connectBehaviours.push(async () => {
          throw new Error("ECONNREFUSED");
        });
      }
    }

    it("opens a single replacement when the same connection reports several errors", async () => {
      vi.useFakeTimers();
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);
      const firstClient = latestClient();

      firstClient.emit("error", new Error("first"));
      firstClient.emit("error", new Error("second"));
      firstClient.emit("error", new Error("third"));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(FakePgClient.instances).toHaveLength(2);
      expect(firstClient.endCallCount).toBe(1);
    });

    it("closes a client whose connect failed, and does not double up if it also reports an error", async () => {
      vi.useFakeTimers();
      failConnectTimes(1);
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);
      const failedClient = latestClient();
      expect(failedClient.endCallCount).toBe(1);

      failedClient.emit("error", new Error("late error from the half-open socket"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakePgClient.instances).toHaveLength(2);
    });

    it("starts the backoff over at 1 second when a connection that had been listening drops", async () => {
      vi.useFakeTimers();
      failConnectTimes(3);
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 5_000);
      expect(FakePgClient.instances).toHaveLength(4);
      expect(latestClient().queries).toEqual(["LISTEN app_notifications_channel"]);

      latestClient().emit("error", new Error("dropped after a long healthy stretch"));
      await vi.advanceTimersByTimeAsync(999);
      expect(FakePgClient.instances).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakePgClient.instances).toHaveLength(5);
    });

    it("keeps resetting on every later drop of a working connection, not only the first", async () => {
      vi.useFakeTimers();
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);
      for (let drop = 0; drop < 4; drop++) {
        const clientsBefore = FakePgClient.instances.length;
        latestClient().emit("error", new Error(`drop ${drop}`));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(FakePgClient.instances).toHaveLength(clientsBefore + 1);
      }
    });

    it("still climbs the backoff while connects keep failing after a drop", async () => {
      vi.useFakeTimers();
      startNotificationBroadcaster();
      await vi.advanceTimersByTimeAsync(0);
      failConnectTimes(2);
      latestClient().emit("error", new Error("dropped"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakePgClient.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(FakePgClient.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakePgClient.instances).toHaveLength(3);
    });
  });
});
