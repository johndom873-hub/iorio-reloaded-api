import { EventName, IBApi } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";

// Audit D (2026-10-07): SharedReadConnection.listenerCount() on a real (never connected) IBApi, which is an eventemitter3 emitter.
vi.mock("./ibkrGatewayTunnel.js", () => ({ openIbkrTunnel: vi.fn() }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: vi.fn() }));
vi.mock("../lib/backgroundFailureAlert.js", () => ({ reportBackgroundFailure: vi.fn(), reportBackgroundRecovery: vi.fn() }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));
vi.mock("../config/env.js", () => ({ environment: { ibkrTunnelSshHost: "vps.example", ibkrTunnelSshPort: 2222, ibkrTunnelSshUsername: "tunnel", ibkrTunnelSshPrivateKeyBase64: "", ibkrGatewayHost: "gateway.internal", ibkrTradingMode: "paper" } }));

const { SharedReadConnection } = await import("./sharedReadConnection.js");

function connectionWith(ib: IBApi | null) {
  const connection = new SharedReadConnection({ label: "audit", maxRequestsPerSecond: 10, clientIdRangeStart: 1_000_000, clientIdRangeSize: 500_000 });
  (connection as unknown as { ib: IBApi | null }).ib = ib;
  return connection;
}

describe("SharedReadConnection.listenerCount — audit D", () => {
  it("is 0 with no connection", () => {
    expect(connectionWith(null).listenerCount()).toBe(0);
  });

  it("sums listeners across every event (on and once), and falls back as they are removed", () => {
    const ib = new IBApi({ host: "127.0.0.1", port: 1 });
    const connection = connectionWith(ib);
    const baseline = connection.listenerCount();
    const onTick = () => {};
    ib.on(EventName.tickPrice, onTick);
    ib.on(EventName.tickPrice, () => {});
    ib.on(EventName.error, () => {});
    ib.once(EventName.disconnected, () => {});
    expect(connection.listenerCount()).toBe(baseline + 4);
    ib.off(EventName.tickPrice, onTick);
    expect(connection.listenerCount()).toBe(baseline + 3);
    ib.emit(EventName.disconnected);
    expect(connection.listenerCount()).toBe(baseline + 2);
    ib.removeAllListeners();
    expect(connection.listenerCount()).toBe(0);
  });
});
