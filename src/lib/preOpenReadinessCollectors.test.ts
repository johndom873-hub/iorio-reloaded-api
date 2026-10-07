import { OptionType, OrderAction } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleGraceMs, type PooledQuote } from "../ibkr/marketDataPool.js";
import { collectReadinessChecks, createDefaultReadinessDependencies, type ProbeContract, type ReadinessDependencies } from "./preOpenReadinessCollectors.js";
import { productionConfigurationExpectations, type ReadinessCheck } from "./preOpenReadiness.js";

const mocks = vi.hoisted(() => {
  const state = { resultsByTable: {} as Record<string, unknown>, rawRows: [] as unknown[] };
  const queries: { table: string; operations: { method: string; args: unknown[] }[] }[] = [];

  // Chainable, thenable stand-in for a knex query builder that records every call and resolves to the canned result of its table.
  function createBuilder(table: string): object {
    const query: (typeof queries)[number] = { table, operations: [] };
    queries.push(query);
    const builder: object = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) => Promise.resolve(state.resultsByTable[table]).then(onFulfilled, onRejected);
          }
          return (...args: unknown[]) => {
            query.operations.push({ method: String(property), args });
            return builder;
          };
        },
      },
    );
    return builder;
  }

  const db = Object.assign((table: string) => createBuilder(table), { raw: vi.fn((sql: string) => ({ rows: state.rawRows, sql })) });
  return {
    state,
    queries,
    db,
    readAppEnvironment: vi.fn(),
    ibkrMarketDataLinesEnabled: vi.fn(),
    fetchAccountSummary: vi.fn(),
    fetchWhatIfCommissionRange: vi.fn(),
    subscribeToPooledQuote: vi.fn(),
    marketDataFeedRefusal: vi.fn(),
    evaluateDataInvariants: vi.fn(),
    loadDataInvariantInputs: vi.fn(),
    lastCompletedSessionDate: vi.fn(),
    loadUndeliveredAlerts: vi.fn(),
    loadTradingSettingsForEditing: vi.fn(),
    fetchTradingHalt: vi.fn(),
    loadLatestRunPerExpectedJob: vi.fn(),
    findDeadlineProblems: vi.fn(),
  };
});

vi.mock("../db/connection.js", () => ({ db: mocks.db }));
vi.mock("../config/env.js", () => ({ ibkrMarketDataLinesEnabled: mocks.ibkrMarketDataLinesEnabled }));
vi.mock("./appEnvironment.js", () => ({ readAppEnvironment: mocks.readAppEnvironment }));
vi.mock("../ibkr/fetchAccountSummary.js", () => ({ fetchAccountSummary: mocks.fetchAccountSummary }));
vi.mock("../ibkr/ibkrWhatIfCommission.js", () => ({ fetchWhatIfCommissionRange: mocks.fetchWhatIfCommissionRange }));
vi.mock("../ibkr/marketDataPool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ibkr/marketDataPool.js")>()),
  subscribeToPooledQuote: mocks.subscribeToPooledQuote,
  marketDataFeedRefusal: mocks.marketDataFeedRefusal,
}));
vi.mock("./dataInvariants.js", () => ({ evaluateDataInvariants: mocks.evaluateDataInvariants, loadDataInvariantInputs: mocks.loadDataInvariantInputs }));
vi.mock("./marketSessionStatus.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./marketSessionStatus.js")>()), lastCompletedSessionDate: mocks.lastCompletedSessionDate }));
vi.mock("./undeliveredAlerts.js", () => ({ loadUndeliveredAlerts: mocks.loadUndeliveredAlerts }));
vi.mock("./tradingSettingsStore.js", () => ({ loadTradingSettingsForEditing: mocks.loadTradingSettingsForEditing }));
vi.mock("./platformControls.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./platformControls.js")>()), fetchTradingHalt: mocks.fetchTradingHalt }));
vi.mock("./opsMonitor.js", () => ({ loadLatestRunPerExpectedJob: mocks.loadLatestRunPerExpectedJob, findDeadlineProblems: mocks.findDeadlineProblems }));

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
    dataSessionIso: async () => "2026-10-02",
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

  it("passes the data session to the data checks and names it", async () => {
    const dependencies = healthyDependencies({ dataSessionIso: async () => "2026-10-02", loadDataInvariants: async (_now, previousSession) => [{ name: "Surface fits", ok: previousSession === "2026-10-02", detail: `for ${previousSession}` }] });
    const checks = await collectReadinessChecks("pre_open", now, dependencies);
    expect(checks.find((entry) => entry.name.startsWith("Data:"))).toMatchObject({ name: "Data: Surface fits (2026-10-02)", status: "ok", detail: "for 2026-10-02" });
  });
});

describe("collectReadinessChecks timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails a reading that never answers after 25 seconds, naming the reading, and still judges the other areas", async () => {
    const pending = collectReadinessChecks("pre_open", now, healthyDependencies({ loadWorkerRow: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(24_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const checks = await pending;
    expect(checks.find((entry) => entry.name === "Trading worker")).toEqual({ name: "Trading worker", status: "fail", detail: "could not be read: the worker heartbeat did not answer within 25s" });
    expect(checks.find((entry) => entry.name === "Account")).toMatchObject({ status: "ok" });
  });

  it("reports an order path probe that never answers as a failing order path with the timeout as the reason", async () => {
    const pending = collectReadinessChecks("pre_open", now, healthyDependencies({ probeOrderPath: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(25_000);
    const checks = await pending;
    expect(checks.find((entry) => entry.name === "Order path")).toMatchObject({ status: "fail", detail: expect.stringContaining("the IBKR what-if probe did not answer within 25s") });
  });

  it("fails the market data reading when the live quote probe never answers", async () => {
    const pending = collectReadinessChecks("pre_open", now, healthyDependencies({ loadMarketDataFigures: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(25_000);
    const checks = await pending;
    expect(checks.find((entry) => entry.name === "Market data")).toEqual({ name: "Market data", status: "fail", detail: "could not be read: the live quote probe did not answer within 25s" });
  });
});

function quote(overrides: Partial<PooledQuote> = {}): PooledQuote {
  return { last: null, bid: null, ask: null, delta: null, gamma: null, vega: null, theta: null, impliedVolatility: null, underlyingPrice: null, open: null, high: null, low: null, previousClose: null, volume: null, ...overrides };
}

function queriesOn(table: string) {
  return mocks.queries.filter((query) => query.table === table);
}

function operationArgs(query: { operations: { method: string; args: unknown[] }[] }, method: string): unknown[][] {
  return query.operations.filter((operation) => operation.method === method).map((operation) => operation.args);
}

describe("createDefaultReadinessDependencies", () => {
  beforeEach(() => {
    mocks.queries.length = 0;
    mocks.state.resultsByTable = {};
    mocks.state.rawRows = [];
    for (const mock of Object.values(mocks)) if (typeof mock === "function" && "mockReset" in mock) (mock as ReturnType<typeof vi.fn>).mockReset();
    mocks.db.raw.mockReset();
    mocks.db.raw.mockImplementation((sql: string) => ({ rows: mocks.state.rawRows, sql }));
    mocks.readAppEnvironment.mockReturnValue("staging");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the app environment and the process environment", () => {
    const dependencies = createDefaultReadinessDependencies();
    expect(dependencies.appEnvironment).toBe("staging");
    expect(dependencies.readEnvironment()).toBe(process.env);
  });

  describe("loadWorkerRow", () => {
    it("is null when the worker never wrote a heartbeat", async () => {
      mocks.state.resultsByTable.worker_health = undefined;
      expect(await createDefaultReadinessDependencies().loadWorkerRow()).toBeNull();
      expect(operationArgs(queriesOn("worker_health")[0]!, "where")).toEqual([[{ process_name: "ibkr_gateway_worker" }]]);
    });

    it("maps the heartbeat row, shortening the git sha to 7 characters", async () => {
      mocks.state.resultsByTable.worker_health = {
        updated_at: "2026-10-05T09:59:40Z",
        connected: true,
        app_environment: "production",
        account_binding_status: "ok",
        account_binding_reason: null,
        ibkr_account_ids: ["U21518308"],
        detected_trading_mode: "live",
        configured_trading_mode: "live",
        git_sha: "abc1234def5678",
      };
      expect(await createDefaultReadinessDependencies().loadWorkerRow()).toEqual({
        updatedAt: new Date("2026-10-05T09:59:40Z"),
        connected: true,
        appEnvironment: "production",
        accountBindingStatus: "ok",
        accountBindingReason: null,
        ibkrAccountIds: ["U21518308"],
        detectedTradingMode: "live",
        configuredTradingMode: "live",
        gitSha: "abc1234",
      });
    });

    it("gives a null git sha for a heartbeat that has none", async () => {
      mocks.state.resultsByTable.worker_health = { updated_at: new Date("2026-10-05T09:59:40Z"), git_sha: null };
      expect((await createDefaultReadinessDependencies().loadWorkerRow())?.gitSha).toBeNull();
    });
  });

  it("reads the trading settings and the trading halt from their stores", async () => {
    const settings = { maxPositionPctOfPortfolio: 15 };
    const halt = { enabled: false };
    mocks.loadTradingSettingsForEditing.mockResolvedValue(settings);
    mocks.fetchTradingHalt.mockResolvedValue(halt);
    const dependencies = createDefaultReadinessDependencies();
    expect(await dependencies.loadSettings()).toBe(settings);
    expect(await dependencies.loadTradingHalt()).toBe(halt);
  });

  it("keeps only the four account figures the check judges", async () => {
    mocks.fetchAccountSummary.mockResolvedValue({ netLiquidationValue: 100_000, totalCashValue: 60_000, buyingPower: 200_000, excessLiquidity: 50_000, accountId: "U1", currency: "USD" });
    expect(await createDefaultReadinessDependencies().loadAccount()).toEqual({ netLiquidationValue: 100_000, totalCashValue: 60_000, buyingPower: 200_000, excessLiquidity: 50_000 });
  });

  describe("loadProbeContract", () => {
    it("is null when no stored chain has a put expiring more than 5 days out with a bid", async () => {
      mocks.state.resultsByTable["option_quote_snapshots as q"] = undefined;
      expect(await createDefaultReadinessDependencies().loadProbeContract()).toBeNull();
    });

    it("maps the stored put to a probe contract with numeric strike and bid", async () => {
      mocks.state.resultsByTable["option_quote_snapshots as q"] = { symbol: "SPY", strike: "500.00", bid: "1.2300", expiryYyyymmdd: "20261120" };
      expect(await createDefaultReadinessDependencies().loadProbeContract()).toEqual({ symbol: "SPY", expiryYyyymmdd: "20261120", strike: 500, right: "P", bid: 1.23 });
    });

    it("looks for puts expiring more than 5 days out that have a bid, newest snapshot day first and highest open interest first", async () => {
      await createDefaultReadinessDependencies().loadProbeContract();
      const [query] = queriesOn("option_quote_snapshots as q");
      expect(operationArgs(query!, "where")).toEqual([["q.option_right", "P"], ["q.bid", ">", 0]]);
      expect(operationArgs(query!, "whereRaw")).toEqual([["q.expiry > current_date + 5"]]);
      expect(operationArgs(query!, "orderBy")).toEqual([[[{ column: "s.trading_date", order: "desc" }, { column: "q.open_interest", order: "desc", nulls: "last" }]]]);
    });
  });

  describe("probeOrderPath", () => {
    const contract: ProbeContract = { symbol: "SPY", expiryYyyymmdd: "20261120", strike: 500, right: "P", bid: 1.234 };

    it("fails without asking IBKR when there is no stored contract to probe with", async () => {
      expect(await createDefaultReadinessDependencies().probeOrderPath(null)).toEqual({ ok: false, reason: "no stored option contract to probe with (no option chain snapshot yet)" });
      expect(mocks.fetchWhatIfCommissionRange).not.toHaveBeenCalled();
    });

    it("asks IBKR's what-if for one short contract of the stored put at its bid rounded to cents, and names the probe", async () => {
      mocks.fetchWhatIfCommissionRange.mockResolvedValue({ min: 1, max: 2 });
      expect(await createDefaultReadinessDependencies().probeOrderPath(contract)).toEqual({ ok: true, probe: "SPY $500 put 20261120" });
      expect(mocks.fetchWhatIfCommissionRange).toHaveBeenCalledWith([
        { role: "option", action: OrderAction.SELL, symbol: "SPY", quantity: 1, unitPrice: 1.23, strike: 500, expiry: "20261120", right: "P" },
      ]);
    });

    it("rounds the limit price to the nearest cent (bid 1.236 gives 1.24)", async () => {
      mocks.fetchWhatIfCommissionRange.mockResolvedValue({});
      await createDefaultReadinessDependencies().probeOrderPath({ ...contract, bid: 1.236 });
      expect(mocks.fetchWhatIfCommissionRange.mock.calls[0]![0][0].unitPrice).toBe(1.24);
    });

    it("never probes with a limit price below one cent (bid 0.004 gives 0.01)", async () => {
      mocks.fetchWhatIfCommissionRange.mockResolvedValue({});
      await createDefaultReadinessDependencies().probeOrderPath({ ...contract, bid: 0.004 });
      expect(mocks.fetchWhatIfCommissionRange.mock.calls[0]![0][0].unitPrice).toBe(0.01);
    });

    it("prints a fractional strike as is in the probe name", async () => {
      mocks.fetchWhatIfCommissionRange.mockResolvedValue({});
      expect(await createDefaultReadinessDependencies().probeOrderPath({ ...contract, symbol: "QQQ", strike: 52.5 })).toEqual({ ok: true, probe: "QQQ $52.5 put 20261120" });
    });

    it("lets IBKR's refusal reach the caller", async () => {
      mocks.fetchWhatIfCommissionRange.mockRejectedValue(new Error("IBKR what-if rejected (201): no permissions"));
      await expect(createDefaultReadinessDependencies().probeOrderPath(contract)).rejects.toThrow("IBKR what-if rejected (201): no permissions");
    });
  });

  describe("loadActiveOrders", () => {
    it("maps the live-status order rows, with ? for an order whose payload has no symbol", async () => {
      mocks.state.resultsByTable.order_requests = [
        { status: "submitted", created_at: "2026-10-05T09:30:00Z", symbol: "SPY" },
        { status: "pending_confirmation", created_at: new Date("2026-10-05T09:31:00Z"), symbol: null },
      ];
      expect(await createDefaultReadinessDependencies().loadActiveOrders()).toEqual([
        { status: "submitted", symbol: "SPY", createdAt: new Date("2026-10-05T09:30:00Z") },
        { status: "pending_confirmation", symbol: "?", createdAt: new Date("2026-10-05T09:31:00Z") },
      ]);
      expect(operationArgs(queriesOn("order_requests")[0]!, "whereIn")).toEqual([["status", ["pending_confirmation", "confirmed", "submitted", "partially_filled", "cancel_requested"]]]);
    });

    it("is empty when no order is active", async () => {
      mocks.state.resultsByTable.order_requests = [];
      expect(await createDefaultReadinessDependencies().loadActiveOrders()).toEqual([]);
    });
  });

  it("reads the latest run of each expected job from the ops monitor", async () => {
    const startedAt = new Date("2026-10-02T22:30:00Z");
    mocks.loadLatestRunPerExpectedJob.mockResolvedValue([
      { jobName: "daily_pnl_snapshot", lastStartedAt: startedAt, status: "failure", errorMessage: "timeout", extra: 1 },
      { jobName: "ibkr_health_check", lastStartedAt: null, status: "never_run", errorMessage: null },
    ]);
    expect(await createDefaultReadinessDependencies().loadLatestJobRuns()).toEqual([
      { jobName: "daily_pnl_snapshot", startedAt, status: "failure", errorMessage: "timeout" },
      { jobName: "ibkr_health_check", startedAt: null, status: "never_run", errorMessage: null },
    ]);
  });

  describe("loadJobsDueButNotStarted", () => {
    it("names the jobs behind deadline problems, leaving out stuck-run problems and problems of other kinds", async () => {
      mocks.findDeadlineProblems.mockResolvedValue({
        problems: [
          { alertKey: "deadline:daily_pnl_snapshot:2026-10-05" },
          { alertKey: "deadline:daily_market_data_capture:stuck:2026-10-05" },
          { alertKey: "failure:daily_pnl_snapshot" },
          { alertKey: "deadline:ibkr_health_check:2026-10-05" },
        ],
      });
      expect(await createDefaultReadinessDependencies().loadJobsDueButNotStarted(now)).toEqual(["daily_pnl_snapshot", "ibkr_health_check"]);
      expect(mocks.findDeadlineProblems).toHaveBeenCalledWith(now);
    });

    it("is empty when no deadline is missed", async () => {
      mocks.findDeadlineProblems.mockResolvedValue({ problems: [] });
      expect(await createDefaultReadinessDependencies().loadJobsDueButNotStarted(now)).toEqual([]);
    });
  });

  describe("loadLatestHealthCheck", () => {
    it("is null before any health check ran", async () => {
      mocks.state.resultsByTable.job_runs = undefined;
      expect(await createDefaultReadinessDependencies().loadLatestHealthCheck()).toBeNull();
    });

    it("gives the newest ibkr_health_check run's start and status", async () => {
      mocks.state.resultsByTable.job_runs = { started_at: "2026-10-05T09:55:00Z", status: "success" };
      expect(await createDefaultReadinessDependencies().loadLatestHealthCheck()).toEqual({ startedAt: new Date("2026-10-05T09:55:00Z"), status: "success" });
      const [query] = queriesOn("job_runs");
      expect(operationArgs(query!, "where")).toEqual([[{ job_name: "ibkr_health_check" }]]);
      expect(operationArgs(query!, "orderBy")).toEqual([["started_at", "desc"]]);
    });
  });

  describe("dataSessionIso", () => {
    it("is the previous session until today's Day Signals seed (the last morning job) has finished", async () => {
      mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-02");
      mocks.state.resultsByTable.job_runs = undefined;
      expect(await createDefaultReadinessDependencies().dataSessionIso(now)).toBe("2026-10-02");
      expect(mocks.lastCompletedSessionDate).toHaveBeenCalledWith(now);
      const [query] = queriesOn("job_runs");
      expect(operationArgs(query!, "where")).toEqual([[{ job_name: "day_signals_seed" }]]);
      expect(operationArgs(query!, "whereRaw")).toEqual([[expect.stringContaining("America/New_York"), ["2026-10-05"]]]);
    });

    it("is today once today's seed has finished, even if it failed", async () => {
      mocks.lastCompletedSessionDate.mockResolvedValue("2026-10-02");
      mocks.state.resultsByTable.job_runs = { id: "seed-run" };
      expect(await createDefaultReadinessDependencies().dataSessionIso(now)).toBe("2026-10-05");
    });
  });

  it("evaluates the data invariants over the inputs loaded for the moment and the previous session", async () => {
    const inputs = { marker: "inputs" };
    const results = [{ name: "Surface fits", ok: true, detail: "fine" }];
    mocks.loadDataInvariantInputs.mockResolvedValue(inputs);
    mocks.evaluateDataInvariants.mockReturnValue(results);
    expect(await createDefaultReadinessDependencies().loadDataInvariants(now, "2026-10-02")).toBe(results);
    expect(mocks.loadDataInvariantInputs).toHaveBeenCalledWith(now, "2026-10-02");
    expect(mocks.evaluateDataInvariants).toHaveBeenCalledWith(inputs);
  });

  it("counts the undelivered alerts", async () => {
    mocks.loadUndeliveredAlerts.mockResolvedValue([{ alertKey: "a" }, { alertKey: "b" }, { alertKey: "c" }]);
    expect(await createDefaultReadinessDependencies().countUndeliveredAlerts()).toBe(3);
  });

  describe("loadDatabaseFigures", () => {
    beforeEach(() => {
      mocks.state.rawRows = [{ totalConnections: "7", maxConnections: "20", sizeBytes: "123456789" }];
    });

    it("turns the database's text figures into numbers and takes the plan's size cap from DB_PLAN_MAX_SIZE_BYTES", async () => {
      vi.stubEnv("DB_PLAN_MAX_SIZE_BYTES", "10737418240");
      expect(await createDefaultReadinessDependencies().loadDatabaseFigures()).toEqual({ totalConnections: 7, maxConnections: 20, sizeBytes: 123_456_789, maxSizeBytes: 10_737_418_240 });
    });

    it("has no size cap when DB_PLAN_MAX_SIZE_BYTES is unset or empty", async () => {
      vi.stubEnv("DB_PLAN_MAX_SIZE_BYTES", "");
      expect((await createDefaultReadinessDependencies().loadDatabaseFigures()).maxSizeBytes).toBeNull();
      vi.stubEnv("DB_PLAN_MAX_SIZE_BYTES", undefined);
      expect((await createDefaultReadinessDependencies().loadDatabaseFigures()).maxSizeBytes).toBeNull();
    });

    it("counts the connections of this database and uses the role's connection limit, or the server's when the role has none", async () => {
      await createDefaultReadinessDependencies().loadDatabaseFigures();
      const sql = String(mocks.db.raw.mock.calls[0]![0]);
      expect(sql).toContain("pg_stat_activity WHERE datname = current_database()");
      expect(sql).toContain("CASE WHEN rolconnlimit > 0 THEN rolconnlimit ELSE current_setting('max_connections')::int END");
    });
  });

  describe("releaseDescription", () => {
    it("names the Heroku release and the first 7 characters of its commit", () => {
      vi.stubEnv("HEROKU_RELEASE_VERSION", "v216");
      vi.stubEnv("HEROKU_SLUG_COMMIT", "460539e1234567890");
      expect(createDefaultReadinessDependencies().releaseDescription()).toBe("v216 (commit 460539e)");
    });

    it("says unknown for both when the platform did not provide them", () => {
      vi.stubEnv("HEROKU_RELEASE_VERSION", undefined);
      vi.stubEnv("HEROKU_SLUG_COMMIT", undefined);
      expect(createDefaultReadinessDependencies().releaseDescription()).toBe("unknown release (commit unknown)");
    });
  });

  describe("loadMarketDataFigures (the live quote probes)", () => {
    const optionContract: ProbeContract = { symbol: "SPY", expiryYyyymmdd: "20261120", strike: 500, right: "P", bid: 1.2 };
    let unsubscribe: ReturnType<typeof vi.fn>;
    let quoteByContractKey: Record<string, PooledQuote | null>;

    beforeEach(() => {
      vi.useFakeTimers();
      unsubscribe = vi.fn();
      quoteByContractKey = {};
      mocks.ibkrMarketDataLinesEnabled.mockReturnValue(true);
      mocks.marketDataFeedRefusal.mockReturnValue(null);
      // The pool hands a subscriber its current value at once; a contract with no entry never ticks.
      mocks.subscribeToPooledQuote.mockImplementation(async (contract: { key: string }, onQuote: (value: PooledQuote) => void) => {
        const current = quoteByContractKey[contract.key];
        if (current) onQuote(current);
        return unsubscribe;
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("probes SPY as a stock before the open and reads no option", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: 500.1, last: 500.05 });
      const figures = await createDefaultReadinessDependencies().loadMarketDataFigures("pre_open", optionContract);
      expect(figures).toEqual({ linesEnabled: true, feedRefusal: null, stockProbe: { symbol: "SPY", bid: 500, ask: 500.1, delta: null }, optionProbe: null });
      expect(mocks.subscribeToPooledQuote).toHaveBeenCalledTimes(1);
      expect(mocks.subscribeToPooledQuote.mock.calls[0]![0]).toEqual({ key: "readiness-stock", legType: "stock", symbol: "SPY" });
    });

    it("answers as soon as the stock has both a bid and an ask, without waiting out the grace period, and gives the line back", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: 500.1 });
      const figures = await createDefaultReadinessDependencies().loadMarketDataFigures("pre_open", null);
      expect(figures.stockProbe).toEqual({ symbol: "SPY", bid: 500, ask: 500.1, delta: null });
      expect(vi.getTimerCount()).toBe(0);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("waits the settle grace for a stock that never ticks, then reports a probe with every figure null and gives the line back", async () => {
      const pending = createDefaultReadinessDependencies().loadMarketDataFigures("pre_open", null);
      await vi.advanceTimersByTimeAsync(settleGraceMs - 1);
      expect(unsubscribe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).stockProbe).toEqual({ symbol: "SPY", bid: null, ask: null, delta: null });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("reports a one-sided quote after the grace period (bid but no ask)", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: null });
      const pending = createDefaultReadinessDependencies().loadMarketDataFigures("pre_open", null);
      await vi.advanceTimersByTimeAsync(settleGraceMs);
      expect((await pending).stockProbe).toEqual({ symbol: "SPY", bid: 500, ask: null, delta: null });
    });

    it("does not need a delta from the stock probe", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: 500.1, delta: null });
      const figures = await createDefaultReadinessDependencies().loadMarketDataFigures("pre_open", null);
      expect(figures.stockProbe?.delta).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("turns a failed stock subscription into a null probe rather than failing the reading", async () => {
      mocks.subscribeToPooledQuote.mockRejectedValue(new Error("shared live connection down"));
      const figures = await createDefaultReadinessDependencies().loadMarketDataFigures("pre_open", null);
      expect(figures.stockProbe).toBeNull();
      expect(figures.linesEnabled).toBe(true);
    });

    it("at the open also probes the stored option, subscribing with its expiry, strike and Put right, and waits for a delta", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: 500.1 });
      quoteByContractKey["readiness-option"] = quote({ bid: 1.2, ask: 1.25, delta: -0.25 });
      const figures = await createDefaultReadinessDependencies().loadMarketDataFigures("open", optionContract);
      expect(figures.optionProbe).toEqual({ symbol: "SPY", bid: 1.2, ask: 1.25, delta: -0.25 });
      expect(mocks.subscribeToPooledQuote.mock.calls[1]![0]).toEqual({ key: "readiness-option", legType: "option", symbol: "SPY", expiry: "20261120", strike: 500, right: OptionType.Put });
      expect(unsubscribe).toHaveBeenCalledTimes(2);
    });

    it("keeps waiting for the option's delta after bid and ask arrived, and reports a null delta once the grace period ends", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: 500.1 });
      quoteByContractKey["readiness-option"] = quote({ bid: 1.2, ask: 1.25, delta: null });
      const pending = createDefaultReadinessDependencies().loadMarketDataFigures("open", optionContract);
      await vi.advanceTimersByTimeAsync(settleGraceMs - 1);
      expect(mocks.subscribeToPooledQuote).toHaveBeenCalledTimes(2);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).optionProbe).toEqual({ symbol: "SPY", bid: 1.2, ask: 1.25, delta: null });
    });

    it("probes a call contract with the Call right", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: 500.1 });
      quoteByContractKey["readiness-option"] = quote({ bid: 1, ask: 1.1, delta: 0.3 });
      await createDefaultReadinessDependencies().loadMarketDataFigures("open", { ...optionContract, right: "C" });
      expect(mocks.subscribeToPooledQuote.mock.calls[1]![0].right).toBe(OptionType.Call);
    });

    it("skips the option probe at the open when there is no stored contract", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: 500.1 });
      const figures = await createDefaultReadinessDependencies().loadMarketDataFigures("open", null);
      expect(figures.optionProbe).toBeNull();
      expect(mocks.subscribeToPooledQuote).toHaveBeenCalledTimes(1);
    });

    it("keeps the stock probe when the option subscription fails", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: 500.1 });
      mocks.subscribeToPooledQuote.mockImplementation(async (contract: { key: string }, onQuote: (value: PooledQuote) => void) => {
        if (contract.key === "readiness-option") throw new Error("no market data lines left");
        onQuote(quoteByContractKey[contract.key]!);
        return unsubscribe;
      });
      const figures = await createDefaultReadinessDependencies().loadMarketDataFigures("open", optionContract);
      expect(figures.stockProbe).toMatchObject({ bid: 500 });
      expect(figures.optionProbe).toBeNull();
    });

    it("uses the latest quote when several arrive before the probe settles", async () => {
      mocks.subscribeToPooledQuote.mockImplementation(async (_contract: unknown, onQuote: (value: PooledQuote) => void) => {
        onQuote(quote({ bid: 499, ask: null }));
        onQuote(quote({ bid: 500, ask: 500.1 }));
        return unsubscribe;
      });
      expect((await createDefaultReadinessDependencies().loadMarketDataFigures("pre_open", null)).stockProbe).toEqual({ symbol: "SPY", bid: 500, ask: 500.1, delta: null });
    });

    it("reports whether real-time lines are enabled and the feed refusal with only its code and message", async () => {
      quoteByContractKey["readiness-stock"] = quote({ bid: 500, ask: 500.1 });
      mocks.ibkrMarketDataLinesEnabled.mockReturnValue(false);
      mocks.marketDataFeedRefusal.mockReturnValue({ code: 10197, message: "No market data during competing live session", since: "2026-10-05T09:00:00Z" });
      const figures = await createDefaultReadinessDependencies().loadMarketDataFigures("pre_open", null);
      expect(figures.linesEnabled).toBe(false);
      expect(figures.feedRefusal).toEqual({ code: 10197, message: "No market data during competing live session" });
    });
  });
});
