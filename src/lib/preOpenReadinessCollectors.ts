import { OrderAction, OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { ibkrMarketDataLinesEnabled } from "../config/env.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { fetchWhatIfCommissionRange } from "../ibkr/ibkrWhatIfCommission.js";
import { marketDataFeedRefusal, subscribeToPooledQuote, waitForFirstReading, type PooledQuote } from "../ibkr/marketDataPool.js";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import type { OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { evaluateDataInvariants, loadDataInvariantInputs, type InvariantResult } from "./dataInvariants.js";
import { readAppEnvironment } from "./appEnvironment.js";
import { easternDateIso, lastCompletedSessionDate } from "./marketSessionStatus.js";
import { loadUndeliveredAlerts } from "./undeliveredAlerts.js";
import { loadTradingSettingsForEditing } from "./tradingSettingsStore.js";
import { fetchTradingHalt, type TradingHalt } from "./platformControls.js";
import {
  configurationExpectationsFor,
  evaluateAccount,
  evaluateConfiguration,
  evaluateDataChecks,
  evaluateDatabase,
  evaluateHealthCheck,
  evaluateJobs,
  evaluateMarketData,
  evaluateOrderHygiene,
  evaluateOrderPath,
  evaluateSettings,
  evaluateTradingHalt,
  evaluateUndeliveredAlerts,
  evaluateWorker,
  type AccountFigures,
  type ActiveOrderRow,
  type LatestJobRun,
  type MarketDataFigures,
  type OrderPathProbeResult,
  type QuoteProbe,
  type ReadinessCheck,
  type ReadinessStage,
  type TradingSettingsFigures,
  type WorkerHealthRow,
} from "./preOpenReadiness.js";

// The I/O half of the pre-open readiness check. Every reading is guarded on its own: a reading that throws or times out becomes a
// red check naming what could not be read, never a silent gap and never a crash that hides the other checks.

export interface ProbeContract {
  symbol: string;
  expiryYyyymmdd: string;
  strike: number;
  right: "C" | "P";
  bid: number;
}

export interface DatabaseFigures {
  totalConnections: number;
  maxConnections: number;
  sizeBytes: number;
  maxSizeBytes: number | null;
}

export interface ReadinessDependencies {
  appEnvironment: string;
  readEnvironment(): Record<string, string | undefined>;
  loadWorkerRow(): Promise<WorkerHealthRow | null>;
  loadSettings(): Promise<TradingSettingsFigures>;
  loadTradingHalt(): Promise<TradingHalt>;
  loadAccount(): Promise<AccountFigures>;
  /** A real listed option from the latest stored chain: the contract the order path and the live option quote are probed with. */
  loadProbeContract(): Promise<ProbeContract | null>;
  probeOrderPath(contract: ProbeContract | null): Promise<OrderPathProbeResult>;
  loadActiveOrders(): Promise<ActiveOrderRow[]>;
  loadLatestJobRuns(): Promise<LatestJobRun[]>;
  loadJobsDueButNotStarted(now: Date): Promise<string[]>;
  loadLatestHealthCheck(): Promise<{ startedAt: Date; status: "running" | "success" | "failure" } | null>;
  /** The trading date the data checks describe: today once today's chain capture has finished, otherwise the last completed session. */
  dataSessionIso(now: Date): Promise<string>;
  loadDataInvariants(now: Date, dataSessionIso: string): Promise<InvariantResult[]>;
  loadMarketDataFigures(stage: ReadinessStage, contract: ProbeContract | null): Promise<MarketDataFigures>;
  countUndeliveredAlerts(): Promise<number>;
  loadDatabaseFigures(): Promise<DatabaseFigures>;
  releaseDescription(): string;
}

const readingTimeoutMs = 25_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not answer within ${readingTimeoutMs / 1000}s`)), readingTimeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Runs one reading and judges it; a throw becomes a failing check named after the reading. */
async function guarded(name: string, read: () => Promise<ReadinessCheck | ReadinessCheck[]>): Promise<ReadinessCheck[]> {
  try {
    const result = await read();
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    return [{ name, status: "fail", detail: `could not be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` }];
  }
}

export async function collectReadinessChecks(stage: ReadinessStage, now: Date, dependencies: ReadinessDependencies): Promise<ReadinessCheck[]> {
  const expectations = configurationExpectationsFor(dependencies.appEnvironment);
  const accountId = dependencies.readEnvironment().IBKR_EXPECTED_ACCOUNT_ID;

  const settingsPromise = dependencies.loadSettings().then((settings) => settings as TradingSettingsFigures | null, () => null);
  const probeContractPromise = dependencies.loadProbeContract().catch(() => null);

  const groups = await Promise.all([
    guarded("Configuration", async () => (expectations ? evaluateConfiguration(dependencies.readEnvironment(), expectations) : { name: "Configuration", status: "warn", detail: `no expected values are defined for the ${dependencies.appEnvironment} environment` })),
    guarded("Trading worker", async () => evaluateWorker(await withTimeout(dependencies.loadWorkerRow(), "the worker heartbeat"), now, { appEnvironment: dependencies.appEnvironment, accountId })),
    guarded("Trading halt", async () => evaluateTradingHalt(await dependencies.loadTradingHalt(), now)),
    guarded("Trading settings", async () => evaluateSettings(await settingsPromise)),
    guarded("Account", async () => {
      const account = await withTimeout(dependencies.loadAccount(), "the IBKR account summary").catch(() => null);
      const settings = await settingsPromise;
      return evaluateAccount(account, settings?.maxPositionPctOfPortfolio ?? null);
    }),
    guarded("Order path", async () => {
      const contract = await probeContractPromise;
      return evaluateOrderPath(await withTimeout(dependencies.probeOrderPath(contract), "the IBKR what-if probe").catch((error): OrderPathProbeResult => ({ ok: false, reason: error instanceof Error ? error.message : String(error) })));
    }),
    guarded("Open orders", async () => evaluateOrderHygiene(await dependencies.loadActiveOrders(), now)),
    guarded("Scheduled jobs", async () => evaluateJobs(await dependencies.loadLatestJobRuns(), await dependencies.loadJobsDueButNotStarted(now))),
    guarded("Gateway health check", async () => evaluateHealthCheck(await dependencies.loadLatestHealthCheck(), now)),
    guarded("Data", async () => {
      const dataSession = await dependencies.dataSessionIso(now);
      return evaluateDataChecks(await dependencies.loadDataInvariants(now, dataSession), dataSession);
    }),
    guarded("Market data", async () => evaluateMarketData(await withTimeout(dependencies.loadMarketDataFigures(stage, await probeContractPromise), "the live quote probe"), stage)),
    guarded("Telegram", async () => evaluateUndeliveredAlerts(await dependencies.countUndeliveredAlerts())),
    guarded("Database", async () => evaluateDatabase(await dependencies.loadDatabaseFigures())),
  ]);
  const release = dependencies.releaseDescription();
  return [...groups.flat(), { name: "Release", status: "ok", detail: release }];
}

// --- The real readings ---

async function probeQuote(contract: PriceContract, symbol: string, needsDelta: boolean): Promise<QuoteProbe> {
  let latest: PooledQuote | null = null;
  let unsubscribe: (() => void) | null = null;
  const { settled, check } = waitForFirstReading(() => latest !== null && latest.bid !== null && latest.ask !== null && (!needsDelta || latest.delta !== null));
  try {
    unsubscribe = await subscribeToPooledQuote(contract, (quote) => {
      latest = quote;
      check();
    });
    await settled;
  } finally {
    unsubscribe?.();
  }
  const quote = latest as PooledQuote | null;
  return { symbol, bid: quote?.bid ?? null, ask: quote?.ask ?? null, delta: quote?.delta ?? null };
}

function probeOptionLeg(contract: ProbeContract): OrderLegPayload {
  return { role: "option", action: OrderAction.SELL, symbol: contract.symbol, quantity: 1, unitPrice: Math.max(0.01, Math.round(contract.bid * 100) / 100), strike: contract.strike, expiry: contract.expiryYyyymmdd, right: contract.right };
}

export function createDefaultReadinessDependencies(): ReadinessDependencies {
  return {
    appEnvironment: readAppEnvironment(),
    readEnvironment: () => process.env,
    loadWorkerRow: async () => {
      const row = await db("worker_health").where({ process_name: "ibkr_gateway_worker" }).first();
      if (!row) return null;
      return {
        updatedAt: new Date(row.updated_at),
        connected: row.connected,
        appEnvironment: row.app_environment,
        accountBindingStatus: row.account_binding_status,
        accountBindingReason: row.account_binding_reason,
        ibkrAccountIds: row.ibkr_account_ids,
        detectedTradingMode: row.detected_trading_mode,
        configuredTradingMode: row.configured_trading_mode,
        gitSha: row.git_sha ? String(row.git_sha).slice(0, 7) : null,
      };
    },
    loadSettings: () => loadTradingSettingsForEditing(),
    loadTradingHalt: () => fetchTradingHalt(),
    loadAccount: async () => {
      const summary = await fetchAccountSummary();
      return { netLiquidationValue: summary.netLiquidationValue, totalCashValue: summary.totalCashValue, buyingPower: summary.buyingPower, excessLiquidity: summary.excessLiquidity };
    },
    loadProbeContract: async () => {
      const row = await db("option_quote_snapshots as q")
        .join("option_chain_snapshots as s", "s.id", "q.snapshot_id")
        .join("tickers as t", "t.id", "s.ticker_id")
        .where("q.option_right", "P")
        .whereRaw("q.expiry > current_date + 5")
        .where("q.bid", ">", 0)
        .orderBy([{ column: "s.trading_date", order: "desc" }, { column: "q.open_interest", order: "desc", nulls: "last" }])
        .first("t.symbol as symbol", "q.strike as strike", "q.bid as bid", db.raw("to_char(q.expiry, 'YYYYMMDD') as \"expiryYyyymmdd\""));
      return row ? { symbol: row.symbol, expiryYyyymmdd: row.expiryYyyymmdd, strike: Number(row.strike), right: "P", bid: Number(row.bid) } : null;
    },
    probeOrderPath: async (contract) => {
      if (!contract) return { ok: false, reason: "no stored option contract to probe with (no option chain snapshot yet)" };
      await fetchWhatIfCommissionRange([probeOptionLeg(contract)]);
      return { ok: true, probe: `${contract.symbol} $${contract.strike} put ${contract.expiryYyyymmdd}` };
    },
    loadActiveOrders: async () => {
      const rows = await db("order_requests").whereIn("status", ["pending_confirmation", "confirmed", "submitted", "partially_filled", "cancel_requested"]).select("status", "created_at", db.raw("payload->>'symbol' as symbol"));
      return rows.map((row) => ({ status: row.status, symbol: row.symbol ?? "?", createdAt: new Date(row.created_at) }));
    },
    loadLatestJobRuns: async () => {
      // Imported here, not at the top: opsMonitor.ts runs this check, so a top-level import would be a cycle.
      const { loadLatestRunPerExpectedJob } = await import("./opsMonitor.js");
      const lines = await loadLatestRunPerExpectedJob();
      return lines.map((line) => ({ jobName: line.jobName, startedAt: line.lastStartedAt, status: line.status, errorMessage: line.errorMessage }));
    },
    loadJobsDueButNotStarted: async (now) => {
      const { findDeadlineProblems } = await import("./opsMonitor.js");
      const { problems } = await findDeadlineProblems(now);
      return problems.filter((problem) => problem.alertKey.startsWith("deadline:") && !problem.alertKey.includes(":stuck:")).map((problem) => problem.alertKey.split(":")[1]!);
    },
    loadLatestHealthCheck: async () => {
      const row = await db("job_runs").where({ job_name: "ibkr_health_check" }).orderBy("started_at", "desc").first("started_at", "status");
      return row ? { startedAt: new Date(row.started_at), status: row.status } : null;
    },
    dataSessionIso: async (now) => {
      const todayIso = easternDateIso(now);
      const captureFinishedToday = await db("job_runs")
        .where({ job_name: "option_chain_capture" })
        .whereNotNull("finished_at")
        .whereRaw("(started_at at time zone 'America/New_York')::date::text = ?", [todayIso])
        .first("job_name");
      return captureFinishedToday ? todayIso : lastCompletedSessionDate(now);
    },
    loadDataInvariants: async (now, dataSessionIso) => evaluateDataInvariants(await loadDataInvariantInputs(now, dataSessionIso)),
    loadMarketDataFigures: async (stage, contract) => {
      const stockProbe = await probeQuote({ key: "readiness-stock", legType: "stock", symbol: "SPY" }, "SPY", false).catch(() => null);
      const optionProbe =
        stage === "open" && contract
          ? await probeQuote({ key: "readiness-option", legType: "option", symbol: contract.symbol, expiry: contract.expiryYyyymmdd, strike: contract.strike, right: contract.right === "C" ? OptionType.Call : OptionType.Put }, contract.symbol, true).catch(() => null)
          : null;
      const refusal = marketDataFeedRefusal();
      return { linesEnabled: ibkrMarketDataLinesEnabled(), feedRefusal: refusal ? { code: refusal.code, message: refusal.message } : null, stockProbe, optionProbe };
    },
    countUndeliveredAlerts: async () => (await loadUndeliveredAlerts()).length,
    loadDatabaseFigures: async () => {
      const result = await db.raw(`
        SELECT
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS "totalConnections",
          (SELECT CASE WHEN rolconnlimit > 0 THEN rolconnlimit ELSE current_setting('max_connections')::int END FROM pg_roles WHERE rolname = current_user) AS "maxConnections",
          pg_database_size(current_database()) AS "sizeBytes"`);
      const row = result.rows[0];
      return { totalConnections: Number(row.totalConnections), maxConnections: Number(row.maxConnections), sizeBytes: Number(row.sizeBytes), maxSizeBytes: process.env.DB_PLAN_MAX_SIZE_BYTES ? Number(process.env.DB_PLAN_MAX_SIZE_BYTES) : null };
    },
    releaseDescription: () => `${process.env.HEROKU_RELEASE_VERSION ?? "unknown release"} (commit ${(process.env.HEROKU_SLUG_COMMIT ?? "unknown").slice(0, 7)})`,
  };
}

