import { EventName, MarketDataType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeBehaviour = "succeed" | "hang" | "error";

const fakeGateway = vi.hoisted(() => ({
  instances: [] as Array<{ options: { host: string; port: number; maxReqPerSec: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; reqMarketDataType: ReturnType<typeof vi.fn>; emit: (eventName: string, ...args: unknown[]) => boolean; listenerCount: (eventName: string) => number }>,
  behaviour: "succeed" as FakeBehaviour,
  openedTunnels: [] as Array<{ localPort: number; close: ReturnType<typeof vi.fn> }>,
}));

vi.mock("@stoqey/ib", async () => {
  const actual = await vi.importActual<typeof import("@stoqey/ib")>("@stoqey/ib");
  const { EventEmitter: NodeEventEmitter } = await import("node:events");
  class FakeIBApi extends NodeEventEmitter {
    connect = vi.fn((_clientId: number) => {
      if (fakeGateway.behaviour === "succeed") this.emit(actual.EventName.nextValidId, 1);
      else if (fakeGateway.behaviour === "error") this.emit(actual.EventName.error, new Error("Connection refused"), 502, 1);
    });
    disconnect = vi.fn(() => {
      this.emit(actual.EventName.disconnected);
    });
    reqMarketDataType = vi.fn();
    constructor(public options: { host: string; port: number; maxReqPerSec: number }) {
      super();
      fakeGateway.instances.push(this as unknown as (typeof fakeGateway.instances)[number]);
    }
  }
  return { ...actual, IBApi: FakeIBApi };
});

const openIbkrTunnelMock = vi.hoisted(() => vi.fn());
vi.mock("./ibkrGatewayTunnel.js", () => ({ openIbkrTunnel: openIbkrTunnelMock }));
const connectToIbkrGatewayMock = vi.hoisted(() => vi.fn());
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: connectToIbkrGatewayMock }));
const reportBackgroundFailureMock = vi.hoisted(() => vi.fn());
const reportBackgroundRecoveryMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/backgroundFailureAlert.js", () => ({ reportBackgroundFailure: reportBackgroundFailureMock, reportBackgroundRecovery: reportBackgroundRecoveryMock }));
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

const { SharedReadConnection, borrowSharedConnectionOrConnect, nextReqIdFor, pickClientId } = await import("./sharedReadConnection.js");
const { requestRealtimeMarketData } = await import("./requestMarketData.js");

type SharedConnectionInstance = InstanceType<typeof SharedReadConnection>;

function createConnection(overrides: Partial<ConstructorParameters<typeof SharedReadConnection>[0]> = {}): SharedConnectionInstance {
  return new SharedReadConnection({ label: "read", maxRequestsPerSecond: 10, clientIdRangeStart: 1_000_000, clientIdRangeSize: 500_000, ...overrides });
}

function latestFakeIb() {
  return fakeGateway.instances.at(-1)!;
}

async function advance(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"));
  fakeGateway.instances.length = 0;
  fakeGateway.openedTunnels.length = 0;
  fakeGateway.behaviour = "succeed";
  openIbkrTunnelMock.mockReset();
  openIbkrTunnelMock.mockImplementation(async () => {
    const tunnel = { localPort: 40_000 + fakeGateway.openedTunnels.length, close: vi.fn() };
    fakeGateway.openedTunnels.push(tunnel);
    return tunnel;
  });
  connectToIbkrGatewayMock.mockReset();
  reportBackgroundFailureMock.mockReset();
  reportBackgroundRecoveryMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pickClientId", () => {
  it("maps the random draw onto the half-open range [start, start + size)", () => {
    const random = vi.spyOn(Math, "random");
    random.mockReturnValue(0);
    expect(pickClientId(1_000_000, 500_000)).toBe(1_000_000);
    random.mockReturnValue(0.9999999);
    expect(pickClientId(1_000_000, 500_000)).toBe(1_499_999);
    random.mockReturnValue(0.5);
    expect(pickClientId(1_500_000, 500_000)).toBe(1_750_000);
  });
});

describe("allocateReqId and nextReqIdFor", () => {
  it("hands out consecutive ids starting at 1, independently per connection", () => {
    const first = createConnection();
    const second = createConnection({ label: "live" });
    expect([first.allocateReqId(), first.allocateReqId(), first.allocateReqId()]).toEqual([1, 2, 3]);
    expect(second.allocateReqId()).toBe(1);
  });

  it("allocates from the connection's counter for its own ib and from the fallback for any other ib", async () => {
    const connection = createConnection();
    const borrowed = await connection.borrow();
    connection.allocateReqId();
    expect(nextReqIdFor(borrowed.ib, () => 9_999)).toBe(2);
    expect(nextReqIdFor(borrowed.ib, () => 9_999)).toBe(3);
    expect(nextReqIdFor({} as never, () => 9_999)).toBe(9_999);
  });
});

describe("borrow", () => {
  it("connects lazily through the tunnel with the configured settings and a client id from its own range", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const connection = createConnection({ clientIdRangeStart: 1_500_000, clientIdRangeSize: 500_000 });
    expect(openIbkrTunnelMock).not.toHaveBeenCalled();

    const borrowed = await connection.borrow();

    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
    const tunnelOptions = openIbkrTunnelMock.mock.calls[0]![0];
    expect(tunnelOptions).toMatchObject({ sshHost: "vps.example", sshPort: 2222, sshUsername: "tunnel", remoteHost: "gateway.internal", remotePort: 4002 });
    expect(tunnelOptions.sshPrivateKey.toString()).toBe("tunnel-key");
    expect(fakeGateway.instances).toHaveLength(1);
    expect(latestFakeIb().options).toEqual({ host: "127.0.0.1", port: 40_000, maxReqPerSec: 10 });
    expect(latestFakeIb().connect).toHaveBeenCalledWith(1_625_000);
    expect(borrowed.ib).toBe(latestFakeIb());
  });

  it("reuses the open connection for later borrows and release leaves it open", async () => {
    const connection = createConnection();
    const first = await connection.borrow();
    first.release();
    const second = await connection.borrow();
    second.release();
    expect(second.ib).toBe(first.ib);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
    expect(latestFakeIb().disconnect).not.toHaveBeenCalled();
    expect(fakeGateway.openedTunnels[0]!.close).not.toHaveBeenCalled();
  });

  it("shares one in-flight connect between concurrent borrowers", async () => {
    const connection = createConnection();
    const [first, second, third] = await Promise.all([connection.borrow(), connection.borrow(), connection.borrow()]);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
    expect(second.ib).toBe(first.ib);
    expect(third.ib).toBe(first.ib);
  });

  it("gives up after the default 3 s when the connection is not ready, but not earlier", async () => {
    openIbkrTunnelMock.mockImplementation(() => new Promise(() => {}));
    const connection = createConnection();
    const outcome = connection.borrow().then(
      () => "borrowed",
      (error: Error) => error.message,
    );
    await advance(2_999);
    let settled = false;
    void outcome.then(() => (settled = true));
    await advance(0);
    expect(settled).toBe(false);
    await advance(1);
    await expect(outcome).resolves.toBe("Shared IBKR read connection not ready within timeout.");
  });

  it("honours a longer timeout set for batch scripts", async () => {
    let finishTunnel: (tunnel: { localPort: number; close: () => void }) => void = () => {};
    openIbkrTunnelMock.mockImplementation(() => new Promise((resolve) => (finishTunnel = resolve)));
    const connection = createConnection();
    connection.setBorrowTimeoutMs(20_000);
    const borrowing = connection.borrow();
    await advance(15_000);
    finishTunnel({ localPort: 41_000, close: vi.fn() });
    await advance(0);
    await expect(borrowing).resolves.toMatchObject({ ib: latestFakeIb() });
  });

  it("keeps the in-flight connect after a borrow timed out so the next borrow reuses it instead of starting a second one", async () => {
    let finishTunnel: (tunnel: { localPort: number; close: () => void }) => void = () => {};
    openIbkrTunnelMock.mockImplementation(() => new Promise((resolve) => (finishTunnel = resolve)));
    const connection = createConnection();
    const timedOut = connection.borrow().catch((error: Error) => error.message);
    await advance(3_000);
    await expect(timedOut).resolves.toContain("not ready within timeout");

    const secondBorrow = connection.borrow();
    finishTunnel({ localPort: 41_001, close: vi.fn() });
    await advance(0);
    await expect(secondBorrow).resolves.toMatchObject({ ib: latestFakeIb() });
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a tunnel failure and retries a fresh connect on the next borrow", async () => {
    openIbkrTunnelMock.mockRejectedValueOnce(new Error("Timed out opening SSH tunnel to IBKR Gateway."));
    const connection = createConnection();
    await expect(connection.borrow()).rejects.toThrow("Timed out opening SSH tunnel to IBKR Gateway.");
    expect(connection.getHealthSnapshot().connected).toBe(false);

    const retried = await connection.borrow();
    expect(retried.ib).toBe(latestFakeIb());
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(2);
    expect(connection.getHealthSnapshot().connected).toBe(true);
  });

  it("fails the connect and closes the tunnel when IBKR rejects the handshake with a real error", async () => {
    fakeGateway.behaviour = "error";
    const connection = createConnection();
    await expect(connection.borrow()).rejects.toThrow("Connection refused");
    expect(fakeGateway.openedTunnels[0]!.close).toHaveBeenCalledTimes(1);
    expect(latestFakeIb().listenerCount(EventName.error)).toBe(0);
    expect(latestFakeIb().listenerCount(EventName.nextValidId)).toBe(0);
    expect(connection.getHealthSnapshot().connected).toBe(false);
  });

  it("ignores reqId -1 status broadcasts during the handshake and still completes on nextValidId", async () => {
    fakeGateway.behaviour = "hang";
    const connection = createConnection();
    const borrowing = connection.borrow();
    await advance(0);
    latestFakeIb().emit(EventName.error, new Error("Market data farm connection is OK:usfarm"), 2104, -1);
    latestFakeIb().emit(EventName.nextValidId, 5);
    await expect(borrowing).resolves.toMatchObject({ ib: latestFakeIb() });
    expect(fakeGateway.openedTunnels[0]!.close).not.toHaveBeenCalled();
  });

  it("times out a handshake that never gets nextValidId after 15 s and closes the tunnel", async () => {
    fakeGateway.behaviour = "hang";
    const connection = createConnection();
    connection.setBorrowTimeoutMs(60_000);
    const outcome = connection.borrow().catch((error: Error) => error.message);
    await advance(14_999);
    expect(fakeGateway.openedTunnels[0]!.close).not.toHaveBeenCalled();
    await advance(1);
    await expect(outcome).resolves.toBe("Timed out connecting to IBKR Gateway.");
    expect(fakeGateway.openedTunnels[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("sets and manages the market data type once on a connection with a fixed type, making later realtime requests no-ops", async () => {
    const connection = createConnection({ label: "live", fixedMarketDataType: MarketDataType.REALTIME });
    const { ib } = await connection.borrow();
    expect(latestFakeIb().reqMarketDataType).toHaveBeenCalledTimes(1);
    expect(latestFakeIb().reqMarketDataType).toHaveBeenCalledWith(MarketDataType.REALTIME);
    requestRealtimeMarketData(ib);
    expect(latestFakeIb().reqMarketDataType).toHaveBeenCalledTimes(1);
  });

  it("leaves the market data type to each borrower on a connection without a fixed type", async () => {
    const connection = createConnection();
    const { ib } = await connection.borrow();
    expect(latestFakeIb().reqMarketDataType).not.toHaveBeenCalled();
    requestRealtimeMarketData(ib);
    expect(latestFakeIb().reqMarketDataType).toHaveBeenCalledWith(MarketDataType.REALTIME);
  });
});

describe("getHealthSnapshot", () => {
  it("reports disconnected with no uptime before the first connect", () => {
    expect(createConnection().getHealthSnapshot()).toEqual({ connected: false, uptimeMs: null, totalReconnects: 0 });
  });

  it("reports uptime since the connect and clears it on a drop while counting the reconnect", async () => {
    const connection = createConnection();
    await connection.borrow();
    await advance(12_500);
    expect(connection.getHealthSnapshot()).toEqual({ connected: true, uptimeMs: 12_500, totalReconnects: 0 });

    latestFakeIb().emit(EventName.disconnected);
    expect(connection.getHealthSnapshot()).toEqual({ connected: false, uptimeMs: null, totalReconnects: 1 });
  });
});

describe("reconnect after a drop", () => {
  async function connectedConnection(): Promise<SharedConnectionInstance> {
    const connection = createConnection();
    await connection.borrow();
    return connection;
  }

  it("leaves no borrow timeout timer running after a successful borrow", async () => {
    await connectedConnection();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the old tunnel, waits 1 s, then reconnects with a new tunnel and a new ib", async () => {
    const connection = await connectedConnection();
    const firstIb = latestFakeIb();
    firstIb.emit(EventName.disconnected);
    expect(fakeGateway.openedTunnels[0]!.close).toHaveBeenCalledTimes(1);

    await advance(999);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(2);
    expect(connection.getHealthSnapshot().connected).toBe(true);
    expect(latestFakeIb()).not.toBe(firstIb);
  });

  it("does not schedule a second reconnect when the disconnect event fires twice in a row", async () => {
    const connection = await connectedConnection();
    const firstIb = latestFakeIb();
    firstIb.emit(EventName.disconnected);
    firstIb.emit(EventName.disconnected);
    await advance(1_000);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(2);
    expect(connection.getHealthSnapshot().totalReconnects).toBe(1);
  });

  it("backs off 1, 2, 5, 10, 30, 60, 60 seconds while connects keep failing", async () => {
    const connection = await connectedConnection();
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
    expect(connection.getHealthSnapshot().connected).toBe(false);
  });

  it("resets the backoff after a successful reconnect", async () => {
    const connection = await connectedConnection();
    openIbkrTunnelMock.mockRejectedValueOnce(new Error("tunnel down")).mockRejectedValueOnce(new Error("tunnel down"));
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000);
    await advance(2_000);
    await advance(5_000);
    expect(connection.getHealthSnapshot().connected).toBe(true);

    openIbkrTunnelMock.mockClear();
    latestFakeIb().emit(EventName.disconnected);
    await advance(999);
    expect(openIbkrTunnelMock).not.toHaveBeenCalled();
    await advance(1);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
  });

  it("counts every failed reconnect attempt in totalReconnects", async () => {
    const connection = await connectedConnection();
    openIbkrTunnelMock.mockRejectedValue(new Error("tunnel down"));
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000 + 2_000);
    expect(connection.getHealthSnapshot().totalReconnects).toBe(3);
  });

  it("makes a borrow during the backoff wait for a connect instead of failing instantly", async () => {
    const connection = await connectedConnection();
    latestFakeIb().emit(EventName.disconnected);
    const borrowing = connection.borrow();
    await advance(0);
    await expect(borrowing).resolves.toMatchObject({ ib: latestFakeIb() });
  });

  it("opens only one tunnel when a borrow lands during the backoff delay: the borrower brings the scheduled attempt forward and the timer never fires a second", async () => {
    const connection = await connectedConnection();
    latestFakeIb().emit(EventName.disconnected);
    openIbkrTunnelMock.mockClear();
    const borrowing = connection.borrow();
    await advance(0);
    await expect(borrowing).resolves.toMatchObject({ ib: latestFakeIb() });
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
  });

  it("keeps backing off when the connect a borrower brought forward fails, instead of stopping the reconnect cycle", async () => {
    const connection = await connectedConnection();
    latestFakeIb().emit(EventName.disconnected);
    openIbkrTunnelMock.mockClear();
    openIbkrTunnelMock.mockRejectedValueOnce(new Error("gateway still down"));
    await expect(connection.borrow()).rejects.toThrow();
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(openIbkrTunnelMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("shutdown cancels the pending reconnect timer: nothing is left to keep a one-shot script alive, and no retry follows", async () => {
    const connection = await connectedConnection();
    latestFakeIb().emit(EventName.disconnected);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await connection.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    openIbkrTunnelMock.mockClear();
    await advance(10_000);
    expect(openIbkrTunnelMock).not.toHaveBeenCalled();
  });

  it("serves a borrow that arrives after the scheduled retry has fired from that same attempt", async () => {
    const connection = await connectedConnection();
    latestFakeIb().emit(EventName.disconnected);
    openIbkrTunnelMock.mockClear();
    await advance(1_000);
    await expect(connection.borrow()).resolves.toMatchObject({ ib: latestFakeIb() });
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
  });
});

describe("outage alert and recovery", () => {
  it("does not alert for a short blip such as the daily Gateway restart, but announces recovery once reconnected", async () => {
    const connection = createConnection();
    await connection.borrow();
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000);
    expect(reportBackgroundFailureMock).not.toHaveBeenCalled();
    expect(reportBackgroundRecoveryMock).toHaveBeenCalledTimes(1);
    expect(reportBackgroundRecoveryMock).toHaveBeenCalledWith("shared-ibkr:read", "The shared IBKR read connection is back");
  });

  it("alerts only once the outage has lasted 10 minutes, naming the connection label", async () => {
    const connection = createConnection({ label: "live" });
    await connection.borrow();
    openIbkrTunnelMock.mockRejectedValue(new Error("gateway down"));
    latestFakeIb().emit(EventName.disconnected);

    await advance(10 * 60_000 - 1);
    expect(reportBackgroundFailureMock).not.toHaveBeenCalled();
    await advance(60_000);
    expect(reportBackgroundFailureMock).toHaveBeenCalled();
    const [source, message] = reportBackgroundFailureMock.mock.calls[0]!;
    expect(source).toBe("shared-ibkr:live");
    expect(message).toContain("The shared IBKR live connection has been down for over 10 min.");
  });

  it("starts the outage clock on a first connect that fails before it ever succeeded", async () => {
    openIbkrTunnelMock.mockRejectedValue(new Error("gateway down at boot"));
    const connection = createConnection();
    await expect(connection.borrow()).rejects.toThrow("gateway down at boot");
    expect(reportBackgroundFailureMock).not.toHaveBeenCalled();

    await advance(9 * 60_000);
    await expect(connection.borrow()).rejects.toThrow();
    expect(reportBackgroundFailureMock).not.toHaveBeenCalled();

    await advance(60_000);
    await expect(connection.borrow()).rejects.toThrow();
    expect(reportBackgroundFailureMock).toHaveBeenCalledTimes(1);
    expect(reportBackgroundFailureMock.mock.calls[0]![0]).toBe("shared-ibkr:read");
  });

  it("announces recovery after a long outage ends and stops alerting", async () => {
    const connection = createConnection();
    await connection.borrow();
    openIbkrTunnelMock.mockRejectedValue(new Error("gateway down"));
    latestFakeIb().emit(EventName.disconnected);
    await advance(11 * 60_000);
    expect(reportBackgroundFailureMock).toHaveBeenCalled();

    openIbkrTunnelMock.mockImplementation(async () => {
      const tunnel = { localPort: 45_000, close: vi.fn() };
      fakeGateway.openedTunnels.push(tunnel);
      return tunnel;
    });
    await advance(60_000);
    expect(connection.getHealthSnapshot().connected).toBe(true);
    expect(reportBackgroundRecoveryMock).toHaveBeenCalledWith("shared-ibkr:read", "The shared IBKR read connection is back");

    reportBackgroundFailureMock.mockClear();
    await advance(15 * 60_000);
    expect(reportBackgroundFailureMock).not.toHaveBeenCalled();
  });

  it("does not report recovery for a connection that never went down", async () => {
    await createConnection().borrow();
    expect(reportBackgroundRecoveryMock).not.toHaveBeenCalled();
  });

  it("starts a fresh outage clock after a recovery", async () => {
    const connection = createConnection();
    await connection.borrow();
    latestFakeIb().emit(EventName.disconnected);
    await advance(1_000);
    expect(connection.getHealthSnapshot().connected).toBe(true);

    await advance(9 * 60_000);
    openIbkrTunnelMock.mockRejectedValue(new Error("gateway down"));
    latestFakeIb().emit(EventName.disconnected);
    await advance(2 * 60_000);
    expect(reportBackgroundFailureMock).not.toHaveBeenCalled();
  });
});

describe("shutdown", () => {
  it("closes the api socket and tunnel and reports disconnected", async () => {
    const connection = createConnection();
    await connection.borrow();
    const ib = latestFakeIb();
    await connection.shutdown();
    expect(ib.disconnect).toHaveBeenCalledTimes(1);
    expect(fakeGateway.openedTunnels[0]!.close).toHaveBeenCalledTimes(1);
    expect(connection.getHealthSnapshot().connected).toBe(false);
  });

  it("suppresses the automatic reconnect that the socket's disconnect event would trigger", async () => {
    const connection = createConnection();
    await connection.borrow();
    await connection.shutdown();
    await advance(5 * 60_000);
    expect(openIbkrTunnelMock).toHaveBeenCalledTimes(1);
    expect(connection.getHealthSnapshot().totalReconnects).toBe(0);
  });

  it("is safe on a connection that never connected and when called twice", async () => {
    const connection = createConnection();
    await expect(connection.shutdown()).resolves.toBeUndefined();
    await expect(connection.shutdown()).resolves.toBeUndefined();
  });

  it("waits for an in-flight connect and then closes what it opened", async () => {
    let finishTunnel: (tunnel: { localPort: number; close: () => void }) => void = () => {};
    const lateTunnelClose = vi.fn();
    openIbkrTunnelMock.mockImplementation(() => new Promise((resolve) => (finishTunnel = resolve)));
    const connection = createConnection();
    void connection.borrow().catch(() => {});
    await advance(0);

    let shutdownDone = false;
    const shuttingDown = connection.shutdown().then(() => (shutdownDone = true));
    await advance(1_000);
    expect(shutdownDone).toBe(false);

    finishTunnel({ localPort: 46_000, close: lateTunnelClose });
    await shuttingDown;
    expect(latestFakeIb().disconnect).toHaveBeenCalledTimes(1);
    expect(lateTunnelClose).toHaveBeenCalledTimes(1);
    expect(connection.getHealthSnapshot().connected).toBe(false);
  });

  it("does not throw when the in-flight connect fails, and raises no outage alert afterwards", async () => {
    let failTunnel: (error: Error) => void = () => {};
    openIbkrTunnelMock.mockImplementation(() => new Promise((_, reject) => (failTunnel = reject)));
    const connection = createConnection();
    connection.setBorrowTimeoutMs(60 * 60_000);
    void connection.borrow().catch(() => {});
    await advance(0);
    const shuttingDown = connection.shutdown();
    await advance(11 * 60_000);
    failTunnel(new Error("late failure"));
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(reportBackgroundFailureMock).not.toHaveBeenCalled();
  });

  it("does not reconnect from a backoff timer that was already pending when shutdown ran", async () => {
    const connection = createConnection();
    await connection.borrow();
    latestFakeIb().emit(EventName.disconnected);
    await connection.shutdown();
    openIbkrTunnelMock.mockClear();
    await advance(1_000);
    expect(openIbkrTunnelMock).not.toHaveBeenCalled();
  });
});

describe("borrowSharedConnectionOrConnect", () => {
  it("returns the shared connection and a release that leaves it open", async () => {
    const connection = createConnection();
    const result = await borrowSharedConnectionOrConnect(connection, "caller");
    result.disconnect();
    expect(result.ib).toBe(latestFakeIb());
    expect(latestFakeIb().disconnect).not.toHaveBeenCalled();
    expect(connectToIbkrGatewayMock).not.toHaveBeenCalled();
  });

  it("falls back to a one-shot connection when the shared one is not ready, and says why", async () => {
    openIbkrTunnelMock.mockRejectedValue(new Error("tunnel down"));
    const oneShot = { ib: { id: "one-shot" }, disconnect: vi.fn() };
    connectToIbkrGatewayMock.mockResolvedValue(oneShot);
    const result = await borrowSharedConnectionOrConnect(createConnection(), "fetchLivePrices");
    expect(result).toBe(oneShot);
    expect(console.log).toHaveBeenCalledWith("fetchLivePrices: shared IBKR connection unavailable (tunnel down), falling back to a one-shot connection.");
  });

  it("falls back when the shared connect times out", async () => {
    openIbkrTunnelMock.mockImplementation(() => new Promise(() => {}));
    connectToIbkrGatewayMock.mockResolvedValue({ ib: {}, disconnect: vi.fn() });
    const pending = borrowSharedConnectionOrConnect(createConnection(), "caller");
    await advance(3_000);
    await pending;
    expect(connectToIbkrGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a failure of the one-shot fallback", async () => {
    openIbkrTunnelMock.mockRejectedValue(new Error("tunnel down"));
    connectToIbkrGatewayMock.mockRejectedValue(new Error("one-shot failed too"));
    await expect(borrowSharedConnectionOrConnect(createConnection(), "caller")).rejects.toThrow("one-shot failed too");
  });
});
