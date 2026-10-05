import { describe, expect, it } from "vitest";
import { collectReadinessChecks, type ProbeContract, type ReadinessDependencies } from "./preOpenReadinessCollectors.js";
import { productionConfigurationExpectations, type ReadinessCheck } from "./preOpenReadiness.js";

const now = new Date("2026-10-05T10:00:00Z");
const probeContract: ProbeContract = { symbol: "SPY", expiryYyyymmdd: "20261120", strike: 500, right: "P", bid: 1.234 };

const secrets = Object.fromEntries(productionConfigurationExpectations.filter((entry) => entry.secret).map((entry) => [entry.name, "set"]));

function healthyDependencies(overrides: Partial<ReadinessDependencies> = {}): ReadinessDependencies & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    appEnvironment: "production",
    readEnvironment: () => ({ ...secrets, APP_ENVIRONMENT: "production", IBKR_TRADING_MODE: "live", IBKR_EXPECTED_ACCOUNT_ID: "U21518308", IBKR_MARKET_DATA_LINES_ENABLED: "true", DAY_SIGNALS_LOOP_ENABLED: "true", EXPIRY_SETTLEMENT_MODE: "apply", GENOSUKE_ENABLED: "true" }),
    loadWorkerRow: async () => ({ updatedAt: new Date(now.getTime() - 20_000), connected: true, appEnvironment: "production", accountBindingStatus: "ok", accountBindingReason: null, ibkrAccountIds: ["U21518308"], detectedTradingMode: "live", configuredTradingMode: "live", gitSha: "abc1234" }),
    loadSettings: async () => ({ maxPositionPctOfPortfolio: 15, maxConcentrationPerTickerPct: 20, minCashReservePct: 5, deltaTargetMin: 0.2, deltaTargetMax: 0.4, recoveryDteMin: 1, recoveryDteMax: 14, minAnnualizedYieldPct: 50, commissionWarnSharePctOfPremium: 5 }),
    loadTradingHalt: async () => ({ enabled: false, reason: null, setByUserId: null, setByDisplayName: null, setAt: null }),
    loadAccount: async () => ({ netLiquidationValue: 100_000, totalCashValue: 60_000, buyingPower: 200_000, excessLiquidity: 50_000 }),
    loadProbeContract: async () => probeContract,
    probeOrderPath: async (contract) => {
      calls.push(`probeOrderPath:${contract?.symbol}`);
      return { ok: true, probe: "SPY $500 put 20261120" };
    },
    loadActiveOrders: async () => [],
    loadLatestJobRuns: async () => [{ jobName: "daily_pnl_snapshot", startedAt: new Date("2026-10-02T22:30:00Z"), status: "success", errorMessage: null }],
    loadJobsDueButNotStarted: async () => [],
    loadLatestHealthCheck: async () => ({ startedAt: new Date(now.getTime() - 5 * 60_000), status: "success" }),
    previousSessionIso: async () => "2026-10-02",
    loadDataInvariants: async () => [{ name: "Surface fits", ok: true, detail: "every snapshot has fitted expiries" }],
    loadMarketDataFigures: async (stage, contract) => {
      calls.push(`marketData:${stage}:${contract?.symbol}`);
      return { linesEnabled: true, feedRefusal: null, stockProbe: { symbol: "SPY", bid: 500, ask: 500.1, delta: null }, optionProbe: stage === "open" ? { symbol: "SPY", bid: 1.2, ask: 1.25, delta: -0.25 } : null };
    },
    countUndeliveredAlerts: async () => 0,
    loadDatabaseFigures: async () => ({ totalConnections: 5, maxConnections: 20, sizeBytes: 10, maxSizeBytes: 100 }),
    releaseDescription: () => "v216 (commit 460539e)",
    ...overrides,
  };
}

const byName = (checks: ReadinessCheck[], name: string) => checks.filter((entry) => entry.name === name || entry.name.startsWith(`${name}:`) || entry.name.startsWith(`${name} `));

describe("collectReadinessChecks", () => {
  it("produces a check for every area, all green for a healthy production before the open", async () => {
    const checks = await collectReadinessChecks("pre_open", now, healthyDependencies());
    expect(checks.filter((entry) => entry.status !== "ok")).toEqual([]);
    for (const name of ["Configuration", "Trading worker", "Trading halt", "Trading settings", "Account", "Order path", "Open orders", "Scheduled jobs", "Gateway health check", "Data", "Market data", "Live stock quote", "Telegram", "Database", "Release"]) {
      expect(byName(checks, name).length, name).toBeGreaterThan(0);
    }
    expect(checks.some((entry) => entry.name === "Live option quote")).toBe(false);
    expect(byName(checks, "Release")[0]!.detail).toBe("v216 (commit 460539e)");
  });

  it("probes the order path and the market data with the same stored contract, and adds the live option check at the open", async () => {
    const dependencies = healthyDependencies();
    const checks = await collectReadinessChecks("open", now, dependencies);
    expect(dependencies.calls).toEqual(expect.arrayContaining(["probeOrderPath:SPY", "marketData:open:SPY"]));
    expect(checks.find((entry) => entry.name === "Live option quote")).toMatchObject({ status: "ok" });
  });

  it("a trading halt left on is a failing check that names who, why and how to resume; a halt that cannot be read fails too", async () => {
    const halted = await collectReadinessChecks(
      "pre_open",
      now,
      healthyDependencies({ loadTradingHalt: async () => ({ enabled: true, reason: "IBKR data looks wrong", setByUserId: "u1", setByDisplayName: "Marce", setAt: new Date(now.getTime() - 60 * 60_000) }) }),
    );
    const haltCheck = halted.find((entry) => entry.name === "Trading halt");
    expect(haltCheck).toMatchObject({ status: "fail" });
    expect(haltCheck?.detail).toContain("switched off by Marce 1h");
    expect(haltCheck?.detail).toContain("IBKR data looks wrong");
    expect(haltCheck?.detail).toContain("Risk & Limits");
    expect(halted.filter((entry) => entry.status === "fail").map((entry) => entry.name)).toEqual(["Trading halt"]);

    const unreadable = await collectReadinessChecks(
      "pre_open",
      now,
      healthyDependencies({
        loadTradingHalt: async () => {
          throw new Error("relation platform_controls does not exist");
        },
      }),
    );
    expect(unreadable.find((entry) => entry.name === "Trading halt")).toEqual({ name: "Trading halt", status: "fail", detail: "could not be read: relation platform_controls does not exist" });
  });

  it("turns a reading that throws into a failing check and still runs every other check", async () => {
    const checks = await collectReadinessChecks(
      "pre_open",
      now,
      healthyDependencies({
        loadWorkerRow: async () => {
          throw new Error("connection refused");
        },
        loadActiveOrders: async () => {
          throw new Error("relation order_requests does not exist\nstack");
        },
      }),
    );
    expect(checks.find((entry) => entry.name === "Trading worker")).toEqual({ name: "Trading worker", status: "fail", detail: "could not be read: connection refused" });
    expect(checks.find((entry) => entry.name === "Open orders")).toMatchObject({ status: "fail", detail: "could not be read: relation order_requests does not exist" });
    expect(checks.find((entry) => entry.name === "Account")).toMatchObject({ status: "ok" });
    expect(checks.find((entry) => entry.name === "Release")).toBeDefined();
  });

  it("fails the account when its summary cannot be read, and the settings check when the settings cannot", async () => {
    const checks = await collectReadinessChecks(
      "pre_open",
      now,
      healthyDependencies({
        loadAccount: async () => {
          throw new Error("timeout");
        },
        loadSettings: async () => {
          throw new Error("no row");
        },
      }),
    );
    expect(checks.find((entry) => entry.name === "Account")).toMatchObject({ status: "fail" });
    expect(checks.find((entry) => entry.name === "Trading settings")).toMatchObject({ status: "fail" });
  });

  it("reports an order path that IBKR refuses, with IBKR's reason, and one with nothing to probe", async () => {
    const refused = await collectReadinessChecks("pre_open", now, healthyDependencies({ probeOrderPath: async () => ({ ok: false, reason: "IBKR what-if rejected (201): no permissions for this options strategy" }) }));
    expect(refused.find((entry) => entry.name === "Order path")).toMatchObject({ status: "fail", detail: expect.stringContaining("no permissions") });
    const thrown = await collectReadinessChecks(
      "pre_open",
      now,
      healthyDependencies({
        probeOrderPath: async () => {
          throw new Error("IBKR what-if timed out.");
        },
      }),
    );
    expect(thrown.find((entry) => entry.name === "Order path")).toMatchObject({ status: "fail", detail: expect.stringContaining("timed out") });
    const noContract = await collectReadinessChecks("pre_open", now, healthyDependencies({ loadProbeContract: async () => null }));
    expect(noContract.find((entry) => entry.name === "Live option quote")).toBeUndefined();
  });

  it("flags a wrong environment configuration and an environment with no expectations", async () => {
    const wrong = await collectReadinessChecks("pre_open", now, healthyDependencies({ readEnvironment: () => ({ ...secrets, APP_ENVIRONMENT: "production", IBKR_TRADING_MODE: "paper" }) }));
    expect(wrong.find((entry) => entry.name === "Configuration")).toMatchObject({ status: "fail" });
    const development = await collectReadinessChecks("pre_open", now, healthyDependencies({ appEnvironment: "development" }));
    expect(development.find((entry) => entry.name === "Configuration")).toMatchObject({ status: "warn", detail: expect.stringContaining("development") });
  });

  it("passes the previous session to the data checks and names it", async () => {
    const dependencies = healthyDependencies({ previousSessionIso: async () => "2026-10-02", loadDataInvariants: async (_now, previousSession) => [{ name: "Surface fits", ok: previousSession === "2026-10-02", detail: `for ${previousSession}` }] });
    const checks = await collectReadinessChecks("pre_open", now, dependencies);
    expect(checks.find((entry) => entry.name.startsWith("Data:"))).toMatchObject({ name: "Data: Surface fits (2026-10-02)", status: "ok", detail: "for 2026-10-02" });
  });
});
