import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// server.ts is the web dyno's bootstrap: it validates its configuration, binds the port and starts the background loops. Everything
// it would start (the Express app, shutdown/crash handlers, IBKR connections, the Telegram bot, monitors) is replaced by mocks here, so
// importing it only exercises its own decisions. dotenv is a no-op so a removed variable stays missing instead of being refilled from .env.
vi.mock("dotenv/config", () => ({}));

const calls = vi.hoisted(() => ({
  listen: vi.fn(),
  installShutdownHandler: vi.fn(),
  startStalePendingOrderSweep: vi.fn(),
  startGenosuke: vi.fn(),
  startNotificationBroadcaster: vi.fn(),
  startDaySignalsLoop: vi.fn(),
  startOpsMonitor: vi.fn(),
  announceWebDynoStart: vi.fn(),
  resumeInterruptedBackfillRuns: vi.fn(),
  borrowRead: vi.fn(),
  borrowLive: vi.fn(),
}));

vi.mock("./lib/installWebCrashAlert.js", () => ({}));
vi.mock("./app.js", () => ({ app: { listen: calls.listen } }));
vi.mock("./lib/installShutdownHandler.js", () => ({ installShutdownHandler: calls.installShutdownHandler }));
vi.mock("./lib/stalePendingOrders.js", () => ({ startStalePendingOrderSweep: calls.startStalePendingOrderSweep }));
vi.mock("./genosuke/bot.js", () => ({ startGenosuke: calls.startGenosuke }));
vi.mock("./lib/notificationBroadcaster.js", () => ({ startNotificationBroadcaster: calls.startNotificationBroadcaster }));
vi.mock("./lib/daySignalsLoop.js", () => ({ startDaySignalsLoop: calls.startDaySignalsLoop }));
vi.mock("./lib/opsMonitor.js", () => ({ startOpsMonitor: calls.startOpsMonitor }));
vi.mock("./lib/webDynoStartNotice.js", () => ({ announceWebDynoStart: calls.announceWebDynoStart }));
vi.mock("./ibkr/tickerBackfillPipeline.js", () => ({ resumeInterruptedBackfillRuns: calls.resumeInterruptedBackfillRuns }));
vi.mock("./ibkr/sharedReadConnection.js", () => ({
  sharedReadConnection: { borrow: calls.borrowRead },
  sharedLiveConnection: { borrow: calls.borrowLive },
}));

const completeBootEnvironment: Record<string, string> = {
  DATABASE_URL: "postgres://example.invalid/unit_test_db",
  FRONTEND_ORIGIN: "https://frontend.unit-test.example",
  IBKR_TRADING_MODE: "paper",
  IBKR_TUNNEL_SSH_HOST: "tunnel.unit-test.example",
  IBKR_TUNNEL_SSH_PORT: "2222",
  IBKR_TUNNEL_SSH_USERNAME: "tunnel-user",
  IBKR_TUNNEL_SSH_PRIVATE_KEY_BASE64: "a2V5",
  IBKR_GATEWAY_HOST: "gateway.unit-test.example",
  PORT: "4321",
  DAY_SIGNALS_LOOP_ENABLED: "true",
  IBKR_MARKET_DATA_LINES_ENABLED: "true",
  PASSKEY_LOGIN: "off",
  PASSKEY_RP_ID: "localhost",
  APP_ENVIRONMENT: "development",
};

function stubBootEnvironment(overrides: Record<string, string | undefined> = {}): void {
  for (const [name, value] of Object.entries({ ...completeBootEnvironment, ...overrides })) {
    if (value === undefined) vi.stubEnv(name, "");
    else vi.stubEnv(name, value);
  }
}

async function importServer(): Promise<void> {
  vi.resetModules();
  await import("./server.js");
}

function runListenCallback(): void {
  const listenCallback = calls.listen.mock.calls[0]?.[1] as () => void;
  listenCallback();
}

beforeEach(() => {
  for (const mock of Object.values(calls)) mock.mockReset();
  calls.borrowRead.mockResolvedValue(undefined);
  calls.borrowLive.mockResolvedValue(undefined);
  calls.announceWebDynoStart.mockResolvedValue(undefined);
  calls.resumeInterruptedBackfillRuns.mockResolvedValue({ resumed: [], notResumed: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("server.ts boot validation", () => {
  it("binds the configured port and installs the shutdown handler once everything is configured", async () => {
    stubBootEnvironment();
    await importServer();
    expect(calls.installShutdownHandler).toHaveBeenCalledWith("web");
    expect(calls.listen).toHaveBeenCalledTimes(1);
    expect(calls.listen.mock.calls[0]?.[0]).toBe(4321);
  });

  it("does not start any background work before the port is bound", async () => {
    stubBootEnvironment();
    await importServer();
    for (const started of [calls.startNotificationBroadcaster, calls.startStalePendingOrderSweep, calls.startGenosuke, calls.startOpsMonitor, calls.startDaySignalsLoop, calls.announceWebDynoStart, calls.resumeInterruptedBackfillRuns, calls.borrowRead, calls.borrowLive]) {
      expect(started).not.toHaveBeenCalled();
    }
  });

  for (const missingName of ["PORT", "DAY_SIGNALS_LOOP_ENABLED", "IBKR_MARKET_DATA_LINES_ENABLED", "PASSKEY_LOGIN", "DATABASE_URL", "FRONTEND_ORIGIN"]) {
    it(`fails fast with a message naming ${missingName} when it is missing, and never binds the port`, async () => {
      stubBootEnvironment({ [missingName]: undefined });
      await expect(importServer()).rejects.toThrow(`Missing required environment variable: ${missingName}`);
      expect(calls.listen).not.toHaveBeenCalled();
    });
  }

  it("fails fast when DAY_SIGNALS_LOOP_ENABLED is neither true nor false", async () => {
    stubBootEnvironment({ DAY_SIGNALS_LOOP_ENABLED: "yes" });
    await expect(importServer()).rejects.toThrow('DAY_SIGNALS_LOOP_ENABLED must be "true" or "false", got: yes');
    expect(calls.listen).not.toHaveBeenCalled();
  });

  it("fails fast when IBKR_MARKET_DATA_LINES_ENABLED is not a boolean", async () => {
    stubBootEnvironment({ IBKR_MARKET_DATA_LINES_ENABLED: "1" });
    await expect(importServer()).rejects.toThrow('IBKR_MARKET_DATA_LINES_ENABLED must be "true" or "false", got: 1');
    expect(calls.listen).not.toHaveBeenCalled();
  });

  it("fails fast when PASSKEY_LOGIN is invalid, or required without a relying party id", async () => {
    stubBootEnvironment({ PASSKEY_LOGIN: "sometimes" });
    await expect(importServer()).rejects.toThrow('PASSKEY_LOGIN must be "off" or "required", got: sometimes');
    stubBootEnvironment({ PASSKEY_LOGIN: "required", PASSKEY_RP_ID: undefined });
    await expect(importServer()).rejects.toThrow("Missing required environment variable: PASSKEY_RP_ID");
    expect(calls.listen).not.toHaveBeenCalled();
  });

  it("does not need a relying party id while passkeys are off", async () => {
    stubBootEnvironment({ PASSKEY_LOGIN: "off", PASSKEY_RP_ID: undefined });
    await importServer();
    expect(calls.listen).toHaveBeenCalledTimes(1);
  });

  it("logs that market-data lines are disabled when the flag is false, and still boots", async () => {
    stubBootEnvironment({ IBKR_MARKET_DATA_LINES_ENABLED: "false" });
    await importServer();
    expect(calls.listen).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(/IBKR market-data lines disabled/);
  });
});

describe("server.ts once the port is bound", () => {
  it("starts the broadcaster, stale-order sweep, bot, monitor and Day Signals loop, warms both IBKR connections and announces the start", async () => {
    stubBootEnvironment({ DAY_SIGNALS_LOOP_ENABLED: "true" });
    await importServer();
    runListenCallback();
    await vi.waitFor(() => expect(calls.announceWebDynoStart).toHaveBeenCalledWith({ subject: "API" }));
    for (const started of [calls.startNotificationBroadcaster, calls.startStalePendingOrderSweep, calls.startGenosuke, calls.startOpsMonitor, calls.startDaySignalsLoop, calls.resumeInterruptedBackfillRuns, calls.borrowRead, calls.borrowLive]) {
      expect(started).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves the Day Signals loop off when DAY_SIGNALS_LOOP_ENABLED is false, starting everything else", async () => {
    stubBootEnvironment({ DAY_SIGNALS_LOOP_ENABLED: "false" });
    await importServer();
    runListenCallback();
    expect(calls.startDaySignalsLoop).not.toHaveBeenCalled();
    expect(calls.startOpsMonitor).toHaveBeenCalledTimes(1);
    expect(calls.startGenosuke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(/Day Signals loop disabled/);
  });

  it("survives a failed start notice and a failed IBKR warm-up: they are logged, never thrown", async () => {
    stubBootEnvironment();
    calls.announceWebDynoStart.mockRejectedValue(new Error("telegram down"));
    calls.borrowRead.mockRejectedValue(new Error("tunnel not ready"));
    calls.borrowLive.mockRejectedValue("gateway not ready");
    await importServer();
    expect(() => runListenCallback()).not.toThrow();
    await vi.waitFor(() => expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(/Could not send the start notice: telegram down/));
    await vi.waitFor(() => {
      const logged = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logged).toMatch(/shared IBKR read connection is still pending \(tunnel not ready\)/);
      expect(logged).toMatch(/shared IBKR live connection is still pending \(gateway not ready\)/);
    });
    expect(calls.startOpsMonitor).toHaveBeenCalledTimes(1);
  });

  it("logs which interrupted ticker setups it restarted and which it only closed", async () => {
    stubBootEnvironment();
    calls.resumeInterruptedBackfillRuns.mockResolvedValue({ resumed: ["TSLA", "AAPL"], notResumed: [{ symbol: "AMD", reason: "already_resumed_once" }] });
    await importServer();
    runListenCallback();
    await vi.waitFor(() => {
      const logged = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logged).toMatch(/Restarted ticker setups cut off by the last restart: TSLA, AAPL\./);
      expect(logged).toMatch(/Ticker setup for AMD was cut off by the last restart and not restarted \(already_resumed_once\)\./);
    });
  });

  it("survives a failed restart of interrupted ticker setups: it is logged, never thrown", async () => {
    stubBootEnvironment();
    calls.resumeInterruptedBackfillRuns.mockRejectedValue(new Error("database not ready"));
    await importServer();
    expect(() => runListenCallback()).not.toThrow();
    await vi.waitFor(() => expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(/Could not restart interrupted ticker setups: database not ready/));
    expect(calls.startOpsMonitor).toHaveBeenCalledTimes(1);
  });
});
