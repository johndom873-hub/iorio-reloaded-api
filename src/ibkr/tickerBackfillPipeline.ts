import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { fetchDailyHistoryFromIbkr, upsertDailyBars } from "./priceBarCache.js";
import { captureAndSave, prepareTicker, type PreparedTicker, type UniverseTicker } from "./runOptionChainCapture.js";
import type { SnapshotCoverage } from "../lib/optionChainCaptureCoverage.js";
import { captureTickerCalendarEvents } from "../lib/tradingviewCalendarService.js";
import { computeMarketSessionStatus, easternDateIso } from "../lib/marketSessionStatus.js";
import { getRiskFreeRate } from "../lib/riskFreeRate.js";
import { summarizeBackfillBars } from "../lib/backfillBarSummary.js";
import type { DailyOhlcvBar } from "../lib/realizedVolatility.js";
import {
  buildInitialBackfillSteps,
  computeProgressPercent,
  deriveFinalRunStatus,
  staleBackfillRunMinutes,
  updateStep,
  type BackfillRunStatus,
  type BackfillStep,
  type BackfillStepKey,
  type BackfillStepStatus,
} from "../lib/tickerBackfillSteps.js";

// New-ticker backfill pipeline (design agreed 2026-09-21): ONE pipeline for
// every add path (manual add, screener add, re-add) that pulls everything
// that can be backfilled for a ticker, reporting step-by-step progress to
// ticker_backfill_runs (streamed to the shortlist progress modal). Replaces
// the old fire-and-forget 1-year backfill in findOrCreateTicker.ts.

export const fiveYearHistoryDuration = "5 Y";

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

export interface TickerBackfillRun {
  id: string;
  tickerId: string;
  status: BackfillRunStatus;
  steps: BackfillStep[];
  progressPercent: number;
  startedAt: string;
  finishedAt: string | null;
}

// --- shared history step (also used by scripts/backfillSignalEngineHistory.ts, one code path) ---

export interface HistoryStepResult {
  barCount: number;
  ivPointCount: number;
  firstTradingDate: string | null;
  lastTradingDate: string | null;
  suspectedSplitDates: string[];
  invalidBarDates: string[];
}

export async function fetchAndStoreFiveYearHistory(connection: IbkrConnection, tickerId: string, symbol: string, options: { dryRun?: boolean; reqId?: number } = {}): Promise<HistoryStepResult> {
  const { bars, ivByDate } = await fetchDailyHistoryFromIbkr(connection, symbol, fiveYearHistoryDuration, options.reqId ?? 1);
  const ohlcvBars: DailyOhlcvBar[] = bars.map((bar) => ({ tradingDate: new Date(bar.time * 1000).toISOString().slice(0, 10), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }));
  const summary = summarizeBackfillBars(ohlcvBars);
  if (!options.dryRun) await upsertDailyBars(tickerId, bars, ivByDate);
  return { ...summary, ivPointCount: ivByDate.size };
}

// --- "preparing" state, used by the nightly jobs and the shortlist ---

function toRun(row: Record<string, unknown>): TickerBackfillRun {
  return {
    id: row.id as string,
    tickerId: row.ticker_id as string,
    status: row.status as BackfillRunStatus,
    steps: row.steps as BackfillStep[],
    progressPercent: row.progress_percent as number,
    startedAt: new Date(row.started_at as string).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
  };
}

export async function getLatestBackfillRun(tickerId: string): Promise<TickerBackfillRun | null> {
  const row = await db("ticker_backfill_runs").where({ ticker_id: tickerId }).orderBy("started_at", "desc").first();
  if (!row) return null;
  const run = toRun(row);
  // A dead 'running' run (dyno restart) is reported as partial, not "preparing" forever.
  if (run.status === "running" && Date.now() - Date.parse(run.startedAt) > staleBackfillRunMinutes * 60_000) {
    return { ...run, status: "partial" };
  }
  return run;
}

// --- orchestration ---

/** Persistence for runs; injectable so the orchestration is testable without a database. */
export interface BackfillRunStore {
  getLatest: (tickerId: string) => Promise<TickerBackfillRun | null>;
  /** Marks any leftover 'running' row for the ticker as partial (a stale one would violate the one-running index). */
  closeRunning: (tickerId: string) => Promise<void>;
  create: (tickerId: string, steps: BackfillStep[]) => Promise<TickerBackfillRun>;
  saveProgress: (runId: string, steps: BackfillStep[]) => Promise<void>;
  finish: (runId: string, status: Exclude<BackfillRunStatus, "running">, steps: BackfillStep[]) => Promise<void>;
}

/** The IBKR/DB/network work each step does; injectable for the same reason. */
export interface BackfillStepWorkers {
  connect: () => Promise<{ ib: IbkrConnection["ib"]; disconnect: () => void }>;
  fetchHistory: (connection: IbkrConnection, tickerId: string, symbol: string) => Promise<HistoryStepResult>;
  captureCalendar: (tickerId: string, symbol: string) => Promise<{ resolved: boolean; earningsWritten: number; dividendsWritten: number }>;
  loadUniverseTicker: (tickerId: string, symbol: string) => Promise<UniverseTicker>;
  prepareChain: (ib: IbkrConnection["ib"], ticker: UniverseTicker, todayIso: string) => Promise<PreparedTicker>;
  isMarketOpen: () => Promise<boolean>;
  getRiskFreeRate: () => Promise<number | null>;
  captureSnapshot: (ib: IbkrConnection["ib"], prepared: PreparedTicker, todayIso: string, riskFreeRatePercent: number | null) => Promise<SnapshotCoverage>;
  now: () => Date;
}

const databaseRunStore: BackfillRunStore = {
  getLatest: getLatestBackfillRun,
  closeRunning: async (tickerId) => {
    await db("ticker_backfill_runs").where({ ticker_id: tickerId, status: "running" }).update({ status: "partial", finished_at: db.fn.now() });
  },
  create: async (tickerId, steps) => {
    const [row] = await db("ticker_backfill_runs").insert({ ticker_id: tickerId, status: "running", steps: JSON.stringify(steps), progress_percent: 0 }).returning("*");
    return toRun(row);
  },
  saveProgress: async (runId, steps) => {
    await db("ticker_backfill_runs").where({ id: runId }).update({ steps: JSON.stringify(steps), progress_percent: computeProgressPercent(steps) });
  },
  finish: async (runId, status, steps) => {
    await db("ticker_backfill_runs").where({ id: runId }).update({ status, steps: JSON.stringify(steps), progress_percent: computeProgressPercent(steps), finished_at: db.fn.now() });
  },
};

const defaultStepWorkers: BackfillStepWorkers = {
  connect: connectToIbkrGateway,
  fetchHistory: (connection, tickerId, symbol) => fetchAndStoreFiveYearHistory(connection, tickerId, symbol),
  captureCalendar: captureTickerCalendarEvents,
  loadUniverseTicker: async (tickerId, symbol) => {
    const row = await db("tickers").where({ id: tickerId }).first();
    return { tickerId, symbol, contractId: (row?.ibkr_contract_id as number | null | undefined) ?? null };
  },
  prepareChain: (ib, ticker, todayIso) => prepareTicker(ib, ticker, todayIso),
  isMarketOpen: async () => (await computeMarketSessionStatus(new Date())).state === "open",
  getRiskFreeRate,
  captureSnapshot: captureAndSave,
  now: () => new Date(),
};

export interface TickerBackfillDependencies {
  store: BackfillRunStore;
  workers: BackfillStepWorkers;
}

const defaultDependencies: TickerBackfillDependencies = { store: databaseRunStore, workers: defaultStepWorkers };

// Serialized: two adds in a row must not run two 5Y historical requests at once (IBKR pacing).
let pipelineQueue: Promise<void> = Promise.resolve();

/**
 * Starts (or joins) the backfill run for a ticker and returns immediately;
 * the work continues in the background. If a fresh run is already in
 * progress for the ticker, that run is returned instead of starting another.
 */
export async function startTickerBackfill(tickerId: string, symbol: string, dependencies: TickerBackfillDependencies = defaultDependencies): Promise<TickerBackfillRun> {
  const current = await dependencies.store.getLatest(tickerId);
  if (current && current.status === "running") return current;

  await dependencies.store.closeRunning(tickerId);
  const run = await dependencies.store.create(tickerId, buildInitialBackfillSteps());

  pipelineQueue = pipelineQueue.then(() => executeBackfillRun(run.id, tickerId, symbol, dependencies)).catch((error) => console.error(`ticker backfill for ${symbol} crashed`, error));
  return run;
}

/** Resolves once everything queued so far has finished (tests; also handy for scripts). */
export function waitForBackfillQueue(): Promise<void> {
  return pipelineQueue;
}

export async function executeBackfillRun(runId: string, tickerId: string, symbol: string, dependencies: TickerBackfillDependencies = defaultDependencies): Promise<void> {
  const { store, workers } = dependencies;
  let steps = buildInitialBackfillSteps();
  const report = async (key: BackfillStepKey, status: BackfillStepStatus, message: string | null) => {
    steps = updateStep(steps, key, status, message);
    await store.saveProgress(runId, steps);
  };
  const runStep = async (key: BackfillStepKey, work: () => Promise<{ status: "done" | "skipped"; message: string }>) => {
    await report(key, "running", null);
    try {
      const result = await work();
      await report(key, result.status, result.message);
    } catch (error) {
      console.error(`ticker backfill: ${symbol} step ${key} failed`, error);
      await report(key, "failed", error instanceof Error ? error.message : String(error));
    }
  };

  let connection: IbkrConnection | null = null;
  const getConnection = async () => (connection ??= (await workers.connect()) as IbkrConnection);
  const todayIso = easternDateIso(workers.now());

  try {
    await runStep("history", async () => {
      const result = await workers.fetchHistory(await getConnection(), tickerId, symbol);
      const splitNote = result.suspectedSplitDates.length > 0 ? ` Possible stock split on ${result.suspectedSplitDates.join(", ")}: check the price history.` : "";
      return { status: "done", message: `${result.barCount} daily bars (${result.firstTradingDate} to ${result.lastTradingDate}), ${result.ivPointCount} implied-volatility points.${splitNote}` };
    });

    await runStep("calendar", async () => {
      const result = await workers.captureCalendar(tickerId, symbol);
      if (!result.resolved) return { status: "skipped", message: "Ticker not found on TradingView; calendar unavailable." };
      return { status: "done", message: `${result.earningsWritten} earnings and ${result.dividendsWritten} dividend events.` };
    });

    let prepared: PreparedTicker | null = null;
    await runStep("chain_warmup", async () => {
      prepared = await workers.prepareChain((await getConnection()).ib, await workers.loadUniverseTicker(tickerId, symbol), todayIso);
      const expiryCount = new Set(prepared.contracts.map((contract) => contract.expiry)).size;
      return { status: "done", message: `${prepared.contracts.length} contracts across ${expiryCount} expiries checked and cached.` };
    });

    await runStep("first_snapshot", async () => {
      if (!(await workers.isMarketOpen())) return { status: "skipped", message: "Market is closed; the first snapshot will be captured by tonight's job." };
      if (!prepared) return { status: "skipped", message: "Skipped because the strike step did not finish." };
      const riskFreeRate = await workers.getRiskFreeRate();
      const coverage = await workers.captureSnapshot((await getConnection()).ib, prepared, todayIso, riskFreeRate === null ? null : riskFreeRate * 100);
      return { status: "done", message: `${coverage.contractsWithAnyTick} of ${coverage.contractsRequested} contracts received quotes.` };
    });
  } finally {
    (connection as IbkrConnection | null)?.disconnect();
    await store.finish(runId, deriveFinalRunStatus(steps), steps);
  }
}
