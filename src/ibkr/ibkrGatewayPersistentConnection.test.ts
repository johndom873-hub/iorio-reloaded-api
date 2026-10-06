import { EventName } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeBehaviour = "succeed" | "hang" | "error";

const fakeGateway = vi.hoisted(() => ({
  instances: [] as Array<{
    options: { host: string; port: number; maxReqPerSec: number };
    connect: ReturnType<typeof vi.fn>;
    emit: (eventName: string, ...args: unknown[]) => boolean;
    listenerCount: (eventName: string) => number;
  }>,
  behaviour: "succeed" as FakeBehaviour,
  nextValidOrderId: 100,
  managedAccountsAnnounced: "DU111, DU222" as string | null,
  openedTunnels: [] as Array<{ localPort: number; close: ReturnType<typeof vi.fn> }>,
}));

vi.mock("@stoqey/ib", async () => {
  const actual = await vi.importActual<typeof import("@stoqey/ib")>("@stoqey/ib");
  const { EventEmitter: NodeEventEmitter } = await import("node:events");
  class FakeIBApi extends NodeEventEmitter {
    connect = vi.fn((_clientId: number) => {
      if (fakeGateway.behaviour === "succeed") {
        if (fakeGateway.managedAccountsAnnounced !== null) this.emit(actual.EventName.managedAccounts, fakeGateway.managedAccountsAnnounced);
        this.emit(actual.EventName.nextValidId, fakeGateway.nextValidOrderId);
      } else if (fakeGateway.behaviour === "error") {
        this.emit(actual.EventName.error, new Error("Connection refused"), 502, 1);
      }
    });
    constructor(public options: { host: string; port: number; maxReqPerSec: number }) {
      super();
      fakeGateway.instances.push(this as unknown as (typeof fakeGateway.instances)[number]);
    }
  }
  return { ...actual, IBApi: FakeIBApi };
});

const openIbkrTunnelMock = vi.hoisted(() => vi.fn());
vi.mock("./ibkrGatewayTunnel.js", () => ({ openIbkrTunnel: openIbkrTunnelMock }));
vi.mock("../config/env.js", () => ({
  environment: {
    ibkrTunnelSshHost: "vps.example",
    ibkrTunnelSshPort: 2222,
    ibkrTunnelSshUsername: "tunnel",
    ibkrTunnelSshPrivateKeyBase64: Buffer.from("tunnel-key").toString("base64"),
    ibkrGatewayHost: "gateway.internal",
    ibkrTradingMode: "paper",
  },
}));

// Midday UTC, well away from the 05:30 UTC planned-restart window that the drop tracker ignores.
const startTime = new Date("2026-10-06T12:00:00.000Z");

async function freshConnection() {
  vi.resetModules();
  const module = await import("./ibkrGatewayPersistentConnection.js");
  return module.persistentIbkrConnection;
}

function latestFakeIb() {
  return fakeGateway.instances.at(-1)!;
}

async function advance(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(startTime);
  fakeGateway.instances.length = 0;
  fakeGateway.openedTunnels.length = 0;
  fakeGateway.behaviour = "succeed";
  fakeGateway.nextValidOrderId = 100;
  fakeGateway.managedAccountsAnnounced = "DU111, DU222";
  openIbkrTunnelMock.mockReset();
  openIbkrTunnelMock.mockImplementation(async () => {
    const tunnel = { localPort: 50_000 + fakeGateway.openedTunnels.length, close: vi.fn() };
    fakeGateway.openedTunnels.push(tunnel);
    return tunnel;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("start and the initial connect", () => {
  it("opens a tunnel with the configured settings and connects with the fixed worker client id and the worker message budget", async () => {
    const connection = await freshConnection();
    await connection.start();

    const tunnelOptions = openIbkrTunnelMock.mock.calls[0]![0];
    expect(tunnelOptions).toMatchObject({ sshHost: "vps.example", sshPort: 2222, sshUsername: "tunnel", remoteHost: "gateway.internal", remotePort: 4002 });
    expect(tunnelOptions.sshPrivateKey.toString()).toBe("tunnel-key");
    expect(latestFakeIb().options).toEqual({ host: "127.0.0.1", port: 50_000, maxReqPerSec: 5 });
    expect(latestFakeIb().connect).toHaveBeenCalledWith(42);
    expect(connection.getIb()).toBe(latestFakeIb());
  });

  it("never rejects when the Gateway is unreachable, stays disconnected and schedules a retry", async () => {
    openIbkrTunnelMock.mockRejectedValue(new Error("Timed out opening SSH tunnel to IBKR Gateway."));
    const connection = await freshConnection();
    await expect(connection.start()).resolves.toBeUndefined();
    expect(connection.getIb()).toBeNull();

    await advance(999);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(2);
  });

  it("treats an IBKR handshake error as a failed connect, closes the tunnel and detaches the handshake listeners", async () => {
    fakeGateway.behaviour = "error";
    const connection = await freshConnection();
    await connection.start();
    expect(connection.getIb()).toBeNull();
    expect(fakeGateway.openedTunnels[0]!.close).toHaveBeenCalledTimes(1);
    expect(latestFakeIb().listenerCount(EventName.error)).toBe(0);
    expect(latestFakeIb().listenerCount(EventName.nextValidId)).toBe(0);
  });

  it("ignores reqId -1 status notices during the handshake", async () => {
    fakeGateway.behaviour = "hang";
    const connection = await freshConnection();
    const starting = connection.start();
    await advance(0);
    latestFakeIb().emit(EventName.error, new Error("Market data farm connection is OK:usfarm"), 2104, -1);
    expect(fakeGateway.openedTunnels[0]!.close).not.toHaveBeenCalled();
    latestFakeIb().emit(EventName.nextValidId, 7);
    await starting;
    expect(connection.getIb()).toBe(latestFakeIb());
  });

  it("gives up a handshake that never produces nextValidId after 15 s, closes the tunnel and retries with backoff", async () => {
    fakeGateway.behaviour = "hang";
    const connection = await freshConnection();
    const starting = connection.start();
    await advance(14_999);
    expect(fakeGateway.openedTunnels[0]!.close).not.toHaveBeenCalled();
    await advance(1);
    await starting;
    expect(fakeGateway.openedTunnels[0]!.close).toHaveBeenCalledTimes(1);
    expect(connection.getIb()).toBeNull();

    fakeGateway.behaviour = "succeed";
    await advance(1_000);
    expect(connection.getIb()).toBe(latestFakeIb());
  });
});

describe("onConnect listeners", () => {
  it("calls a listener registered before the first connect once the connection is up", async () => {
    const connection = await freshConnection();
    const listener = vi.fn();
    connection.onConnect(listener);
    expect(listener).not.toHaveBeenCalled();
    await connection.start();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(latestFakeIb());
  });

  it("calls a listener registered after the connection is up immediately with the current ib", async () => {
    const connection = await freshConnection();
    await connection.start();
    const listener = vi.fn();
    connection.onConnect(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(connection.getIb());
  });

  it("does not call a late listener right away while disconnected, but calls it on the next connect", async () => {
    openIbkrTunnelMock.mockRejectedValueOnce(new Error("down"));
    const connection = await freshConnection();
    await connection.start();
    const listener = vi.fn();
    connection.onConnect(listener);
    expect(listener).not.toHaveBeenCalled();
    await advance(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(latestFakeIb());
  });

  it("keeps the connection and still calls the later listeners when one listener throws, without opening a second session", async () => {
    const connection = await freshConnection();
    const failing = vi.fn(() => {
      throw new Error("listener broke");
    });
    const later = vi.fn();
    connection.onConnect(failing);
    connection.onConnect(later);
    await connection.start();
    const connectedIb = latestFakeIb();
    expect(connection.getIb()).toBe(connectedIb);
    expect(later).toHaveBeenCalledWith(connectedIb);
    await advance(60_000);
    expect(fakeGateway.instances).toHaveLength(1);
  });

  it("calls every listener again with the new ib after each reconnect", async () => {
    const connection = await freshConnection();
    const first = vi.fn();
    const second = vi.fn();
    connection.onConnect(first);
    connection.onConnect(second);
    await connection.start();
    const firstIb = latestFakeIb();
    firstIb.emit(EventName.disconnected);
    await advance(1_000);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenLastCalledWith(latestFakeIb());
    expect(latestFakeIb()).not.toBe(firstIb);
  });
});

describe("getNextOrderId", () => {
  it("throws before any connection has supplied an id", async () => {
    const connection = await freshConnection();
    expect(() => connection.getNextOrderId()).toThrow("No IBKR order id available yet — not connected.");
  });

  it("hands out consecutive ids starting from the nextValidId IBKR sent", async () => {
    fakeGateway.nextValidOrderId = 345;
    const connection = await freshConnection();
    await connection.start();
    expect([connection.getNextOrderId(), connection.getNextOrderId(), connection.getNextOrderId()]).toEqual([345, 346, 347]);
  });

  it("restarts from the fresh nextValidId after a reconnect", async () => {
    fakeGateway.nextValidOrderId = 345;
    const connection = await freshConnection();
    await connection.start();
    connection.getNextOrderId();
    connection.getNextOrderId();
    fakeGateway.nextValidOrderId = 500;
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000);
    expect(connection.getNextOrderId()).toBe(500);
  });

  it("refuses an id while disconnected, even though the counter still holds the last session's value", async () => {
    fakeGateway.nextValidOrderId = 345;
    const connection = await freshConnection();
    await connection.start();
    connection.getNextOrderId();
    openIbkrTunnelMock.mockRejectedValue(new Error("down"));
    latestFakeIb().emit(EventName.disconnected);
    expect(() => connection.getNextOrderId()).toThrow("No IBKR order id available yet — not connected.");
  });

  it("does not consume an id on the failed attempt that threw", async () => {
    const connection = await freshConnection();
    expect(() => connection.getNextOrderId()).toThrow();
    fakeGateway.nextValidOrderId = 10;
    await connection.start();
    expect(connection.getNextOrderId()).toBe(10);
  });
});

describe("disconnect and reconnect", () => {
  it("clears ib, closes the old tunnel and reconnects after 1 s on a new tunnel", async () => {
    const connection = await freshConnection();
    await connection.start();
    const firstIb = latestFakeIb();
    firstIb.emit(EventName.disconnected);
    expect(connection.getIb()).toBeNull();
    expect(fakeGateway.openedTunnels[0]!.close).toHaveBeenCalledTimes(1);

    await advance(999);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(2);
    expect(connection.getIb()).toBe(latestFakeIb());
    expect(latestFakeIb()).not.toBe(firstIb);
  });

  it("schedules one reconnect only, however many times the disconnect fires before the timer", async () => {
    const connection = await freshConnection();
    await connection.start();
    const firstIb = latestFakeIb();
    firstIb.emit(EventName.disconnected);
    firstIb.emit(EventName.disconnected);
    await advance(1_000);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(2);
    expect(connection.getHealthSnapshot().totalReconnects).toBe(1);
  });

  it("backs off 1, 2, 5, 10, 30, 60, 60 seconds while attempts keep failing", async () => {
    const connection = await freshConnection();
    await connection.start();
    openIbkrTunnelMock.mockReset();
    openIbkrTunnelMock.mockRejectedValue(new Error("tunnel down"));
    latestFakeIb().emit(EventName.disconnected);

    const expectedDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000];
    for (const [attemptIndex, delayMs] of expectedDelaysMs.entries()) {
      await advance(delayMs - 1);
      expect(openIbkrTunnelMock).toHaveBeenCalledTimes(attemptIndex);
      await advance(1);
      expect(openIbkrTunnelMock).toHaveBeenCalledTimes(attemptIndex + 1);
    }
    expect(connection.getIb()).toBeNull();
  });

  it("resets the backoff to 1 s after a successful reconnect", async () => {
    const connection = await freshConnection();
    await connection.start();
    openIbkrTunnelMock.mockRejectedValueOnce(new Error("down")).mockRejectedValueOnce(new Error("down"));
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000 + 2_000 + 5_000);
    expect(connection.getIb()).not.toBeNull();

    openIbkrTunnelMock.mockClear();
    latestFakeIb().emit(EventName.disconnected);
    await advance(999);
    expect(openIbkrTunnelMock).not.toHaveBeenCalled();
    await advance(1);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
  });

  it("keeps one retry timer in flight at a time while a long outage continues", async () => {
    const connection = await freshConnection();
    await connection.start();
    openIbkrTunnelMock.mockReset();
    openIbkrTunnelMock.mockRejectedValue(new Error("tunnel down"));
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000 + 2_000 + 5_000 + 10_000);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("clears the stale ib after a failed reconnect handshake and tries again", async () => {
    const connection = await freshConnection();
    await connection.start();
    fakeGateway.behaviour = "error";
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000);
    expect(connection.getIb()).toBeNull();
    fakeGateway.behaviour = "succeed";
    await advance(2_000);
    expect(connection.getIb()).toBe(latestFakeIb());
  });
});

describe("getHealthSnapshot", () => {
  it("starts as disconnected since process start with the fixed client id and no accounts", async () => {
    const connection = await freshConnection();
    expect(connection.getHealthSnapshot()).toEqual({
      connected: false,
      uptimeMs: null,
      disconnectedSinceMs: startTime.getTime(),
      totalReconnects: 0,
      unplannedDropsLast24h: 0,
      lastSystemStatusCode: null,
      clientId: 42,
      managedAccountIds: [],
    });
  });

  it("reports connected with uptime, the accounts IBKR announced and no disconnect time", async () => {
    const connection = await freshConnection();
    await connection.start();
    await advance(30_000);
    expect(connection.getHealthSnapshot()).toEqual({
      connected: true,
      uptimeMs: 30_000,
      disconnectedSinceMs: null,
      totalReconnects: 0,
      unplannedDropsLast24h: 0,
      lastSystemStatusCode: null,
      clientId: 42,
      managedAccountIds: ["DU111", "DU222"],
    });
  });

  it("drops empty entries from the announced accounts list", async () => {
    fakeGateway.managedAccountsAnnounced = " DU111 ,, ";
    const connection = await freshConnection();
    await connection.start();
    expect(connection.getHealthSnapshot().managedAccountIds).toEqual(["DU111"]);
  });

  it("records the drop: uptime cleared, disconnect time set to the first drop, reconnect and unplanned drop counted", async () => {
    const connection = await freshConnection();
    await connection.start();
    await advance(60_000);
    const dropTime = Date.now();
    latestFakeIb().emit(EventName.disconnected);
    expect(connection.getHealthSnapshot()).toMatchObject({ connected: false, uptimeMs: null, disconnectedSinceMs: dropTime, totalReconnects: 1, unplannedDropsLast24h: 1 });
  });

  it("keeps the first disconnect time across failed retries, and counts each failed retry as a drop and a reconnect", async () => {
    const connection = await freshConnection();
    await connection.start();
    const dropTime = Date.now();
    openIbkrTunnelMock.mockRejectedValue(new Error("tunnel down"));
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000 + 2_000);
    expect(connection.getHealthSnapshot()).toMatchObject({ connected: false, disconnectedSinceMs: dropTime, totalReconnects: 3, unplannedDropsLast24h: 3 });
  });

  it("clears the disconnect time again once reconnected, keeping the lifetime counters", async () => {
    const connection = await freshConnection();
    await connection.start();
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000);
    expect(connection.getHealthSnapshot()).toMatchObject({ connected: true, disconnectedSinceMs: null, totalReconnects: 1, unplannedDropsLast24h: 1 });
  });

  it("does not count a drop inside the daily 05:30 UTC planned restart window as unplanned", async () => {
    vi.setSystemTime(new Date("2026-10-06T05:31:00.000Z"));
    const connection = await freshConnection();
    await connection.start();
    latestFakeIb().emit(EventName.disconnected);
    expect(connection.getHealthSnapshot()).toMatchObject({ totalReconnects: 1, unplannedDropsLast24h: 0 });
  });

  it("forgets unplanned drops older than 24 hours", async () => {
    const connection = await freshConnection();
    await connection.start();
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000);
    expect(connection.getHealthSnapshot().unplannedDropsLast24h).toBe(1);
    await advance(24 * 60 * 60_000);
    expect(connection.getHealthSnapshot().unplannedDropsLast24h).toBe(0);
  });

  it("tracks the last reqId -1 system status code only after connect, and ignores order-scoped errors", async () => {
    const connection = await freshConnection();
    await connection.start();
    latestFakeIb().emit(EventName.error, new Error("HMDS data farm connection is broken"), 2105, -1);
    latestFakeIb().emit(EventName.error, new Error("Order rejected"), 201, 33);
    expect(connection.getHealthSnapshot().lastSystemStatusCode).toBe(2105);
    latestFakeIb().emit(EventName.error, new Error("Connectivity restored"), 1102, -1);
    expect(connection.getHealthSnapshot().lastSystemStatusCode).toBe(1102);
  });

  it("forgets the previous session's managed accounts at the start of a reconnect, before the new login announces its own", async () => {
    const connection = await freshConnection();
    await connection.start();
    expect(connection.getHealthSnapshot().managedAccountIds).toEqual(["DU111", "DU222"]);

    fakeGateway.behaviour = "hang";
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000);
    expect(connection.getHealthSnapshot().managedAccountIds).toEqual([]);
    latestFakeIb().emit(EventName.managedAccounts, "U999");
    latestFakeIb().emit(EventName.nextValidId, 1);
    await advance(0);
    expect(connection.getHealthSnapshot().managedAccountIds).toEqual(["U999"]);
  });
});
