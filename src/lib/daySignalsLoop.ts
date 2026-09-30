import type { IBApi } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { runRollingQuoteWindow, type RollingQuoteWindowOptions, type RollingQuoteWindowResult, type WindowContract, type WindowQuote } from "../ibkr/daySignalsQuoteWindow.js";
import { releaseMarketDataLines, reserveMarketDataLines, type LineReservationResult } from "../ibkr/marketDataLineBudget.js";
import { sharedLiveConnection } from "../ibkr/sharedReadConnection.js";
import { readAppEnvironment } from "./appEnvironment.js";
import { emitDayQuotesUpdated } from "./daySignalsEvents.js";
import { selectContractsToCapture, computeStrikeWindow, calendarDaysUntilExpiry } from "./optionChainCaptureWindow.js";
import { selectDaySignalContractSet, shouldRerankExpiries, type DayContractRef, type DayContractSetExpiry } from "./daySignalsContractSet.js";
import { loadDayTickerContractContexts, loadDayUnpooledTickers, type DayTickerContractContext, type DayTrackedTicker } from "./daySignalsContractContextStore.js";
import { selectDaySignalExpiries } from "./daySignalsSeed.js";
import { clearsNotificationHysteresis, decideAssignmentRiskAlert, isGradeUpgrade, notifyAssignmentRisk, notifyRollSignalUpgrade, notifySignalUpgrade, type AssignmentRiskAlert, type RollSignalUpgrade, type SignalUpgrade } from "./daySignalsNotifications.js";
import {
  loadAssignmentRiskAlertStates,
  loadDayRollGrades,
  loadDaySignalExpiries,
  loadDaySignalUniverse,
  loadDayQuotesForTicker,
  loadDayRerankStates,
  pruneDayQuotesOutsideSet,
  rearmAssignmentRiskAlert,
  recordAssignmentRiskAlert,
  replaceTickerPoolExpiries,
  saveDayRerankState,
  updateDayQuoteGrades,
  upsertDayQuotes,
  upsertDayRollGrades,
  type AssignmentRiskAlertState,
  type DayQuoteContract,
  type DayQuoteWrite,
  type DayRerankState,
  type DaySignalExpirySeed,
  type DaySignalExpiryRow,
} from "./daySignalsStore.js";
import { computeMarketSessionStatus, easternDateIso } from "./marketSessionStatus.js";
import { formatIsoDateAsExpiry } from "./optionChainSnapshotStore.js";
import { readGitSha } from "./readGitSha.js";
import { reportBackgroundFailure, reportBackgroundRecovery } from "./backgroundFailureAlert.js";
import type { SignalGrade } from "./signalCandidates.js";
import { rollCandidateKey, type HeldLegScore } from "./rollSignalCandidates.js";
import { candidateContractKey, scoreTicker, type LiveOptionQuote } from "./signalsLiveScoring.js";
import { loadAccountContext, loadTickerSignalsInputs, type SignalsTickerRow } from "./signalsStore.js";
import { loadSignalSettings, type SignalSettings } from "./signalSettingsStore.js";
import type { AccountContext, TickerSignalsInputs } from "./signalsTypes.js";

// The Day Signals refresh loop (design agreed 2026-09-24, PROGRESS.md "DAY
// SIGNALS"). Lives in the web dyno as a background service, gated by
// DAY_SIGNALS_LOOP_ENABLED (local dev and staging share one IBKR login but
// not a reservation table, so an always-on loop would cost 10 lines per
// running environment). Resumable from DB state: nothing lives only in
// memory except the position inside the current cycle.
//
// States, re-evaluated every stateCheckIntervalMs and between cycles:
//   idle    — market closed, or no day_signal_expiries row with today's
//             Eastern trading date (which keeps it idle from 09:30 until the
//             capture + fit + seed have landed, and through the capture
//             window itself), or the 10 lines could not be reserved.
//   running — holder "daySignalsLoop" = 10 lines, one cycle after another
//             over every captured contract of the pooled expiries, ordered
//             ticker → expiry → strike → right, on sharedLiveConnection
//             through a rolling window (daySignalsQuoteWindow.ts). Each
//             ticker's block ends with one transient stock slot whose last
//             price is the spot for that ticker's re-score.
//
// Each cycle starts with a spot pass (every pooled ticker's stock, one line each). The contracts
// quoted for a ticker are then the capture's own rule applied at that LIVE spot (approved 2026-09-29,
// daySignalsContractSet.ts), not the 9:30 snapshot's: a stock that moved after the open would otherwise
// leave a hole where the puts (or calls) it now wants to sell should be. Contracts that stop qualifying
// are dropped and their stored quotes deleted, so the set stays about the same size. A ticker whose spot
// moved by max(1%, half its one-day expected move) since it was last ranked (at most 3 times a day) also
// gets its pooled expiries re-ranked from a one-off discovery pass over all its expiries.
//
// After every ticker's block settles: its quotes are flushed, the ticker is
// re-scored exactly as the screens score it (scoreTicker over the merged
// day quotes), upward grade transitions vs day_signal_quotes.last_grade that
// clear the notification hysteresis and cooldown (daySignalsNotifications.ts,
// daySignalsNotificationCooldownMs) are notified, held short legs that reached
// assignment risk are alerted (decideAssignmentRiskAlert), and dayQuotesUpdated
// fires so open Signals streams reload.

export const daySignalsLoopLineHolder = "daySignalsLoop";
export const daySignalsLoopLines = 10;
const lineReservationTtlSeconds = 90;
const lineReservationRenewIntervalMs = 60_000;
const stateCheckIntervalMs = 30_000;
const afterDisconnectBackoffMs = 5_000;
const heartbeatIntervalMs = 60_000;
// Assumptions to verify on the staging soak (PROGRESS.md): per-contract settle timeout, write batching.
export const daySignalsContractTimeoutMs = 4_000;
// Per-contract notification cooldown (approved 2026-09-24, alongside clearsNotificationHysteresis in
// daySignalsNotifications.ts): once a contract notifies, it stays quiet for this long regardless of
// further grade movement, purely by elapsed time — it does not require the grade to fall back first.
// In-memory only (lastNotifiedAtByKey below), not persisted: a mid-window loop restart resets it, which
// at worst re-notifies a contract slightly early, an acceptable tradeoff against a DB round trip per check.
export const daySignalsNotificationCooldownMs = 10 * 60_000;
const writeFlushIntervalMs = 1_000;
const writeFlushRowCount = 20;

export type DaySignalsLoopState = "disabled" | "idle" | "running";

export interface DaySignalsLoopStatus {
  state: DaySignalsLoopState;
  reason: string;
  stateSince: string;
  tradingDateIso: string | null;
  cycleNumber: number;
  cycleStartedAt: string | null;
  lastCycleDurationMs: number | null;
  contractsInPool: number;
  lastError: string | null;
}

export interface DaySignalsLoopDependencies {
  now(): Date;
  isMarketOpen(now: Date): Promise<boolean>;
  loadPool(tradingDateIso: string): Promise<DaySignalExpiryRow[]>;
  loadUniverse(tradingDateIso: string): Promise<(DayQuoteContract & { symbol: string })[]>;
  reserveLines(holder: string, lines: number, ttlSeconds: number): Promise<LineReservationResult>;
  releaseLines(holder: string): Promise<void>;
  borrowLiveConnection(): Promise<{ ib: IBApi }>;
  allocateReqId(): number;
  runQuoteWindow(contracts: WindowContract[], options: RollingQuoteWindowOptions): Promise<RollingQuoteWindowResult>;
  /** The start-of-cycle pass over every pooled ticker's stock (one line each); the same fetcher as runQuoteWindow, separate so callers can tell them apart. */
  runSpotPass(contracts: WindowContract[], options: RollingQuoteWindowOptions): Promise<RollingQuoteWindowResult>;
  upsertDayQuotes(writes: DayQuoteWrite[]): Promise<void>;
  /** Per pooled ticker: strike grids, ATM IV, held legs and last cycle's contracts. A ticker missing from the map stays on the snapshot's contracts. */
  loadContractContexts(tickers: DayTrackedTicker[], tradingDateIso: string): Promise<Map<string, DayTickerContractContext>>;
  /** Tickers scored at 9:30 that the seed left without a pool: watched for a move big enough to re-rank them into one. */
  loadUnpooledTickers(tradingDateIso: string): Promise<DayTrackedTicker[]>;
  pruneDayQuotes(tickerId: string, keep: DayContractRef[]): Promise<void>;
  loadRerankStates(tradingDateIso: string): Promise<Map<string, DayRerankState>>;
  saveRerankState(tickerId: string, tradingDateIso: string, state: DayRerankState): Promise<void>;
  /** Mid-day re-rank: sets one ticker's pooled expiries (creating its pool when it had none); false for an empty list. */
  replaceTickerPool(tickerId: string, tradingDateIso: string, snapshotId: string, expiries: DaySignalExpirySeed[], seededAt: Date): Promise<boolean>;
  loadTickerSignalsInputs(ticker: SignalsTickerRow): Promise<TickerSignalsInputs>;
  loadAccountContext(): Promise<AccountContext>;
  loadSignalSettings(): Promise<SignalSettings>;
  loadLastGrades(tickerId: string, tradingDateIso: string): Promise<Map<string, SignalGrade | null>>;
  updateDayQuoteGrades(tickerId: string, grades: { expiry: string; strike: number; right: "C" | "P"; grade: SignalGrade }[]): Promise<void>;
  notifyUpgrade(upgrade: SignalUpgrade): Promise<void>;
  /** Roll Signals: last grade per (leg, replacement) key -- `legId|expiry|strike|right`. */
  loadLastRollGrades(tickerId: string, tradingDateIso: string): Promise<Map<string, SignalGrade>>;
  upsertRollGrades(tickerId: string, tradingDateIso: string, grades: { legId: string; expiry: string; strike: number; right: "C" | "P"; grade: SignalGrade }[]): Promise<void>;
  notifyRollUpgrade(upgrade: RollSignalUpgrade): Promise<void>;
  /** Assignment-risk alert state per held leg id (legs with no row are absent). */
  loadAssignmentRiskAlertStates(legIds: string[]): Promise<Map<string, AssignmentRiskAlertState>>;
  recordAssignmentRiskAlert(legId: string, tradingDateIso: string): Promise<void>;
  rearmAssignmentRiskAlert(legId: string): Promise<void>;
  notifyAssignmentRisk(alert: AssignmentRiskAlert): Promise<void>;
  emitUpdated(tickerId: string): void;
  writeHeartbeat(status: DaySignalsLoopStatus): Promise<void>;
  /** Rate-limited Telegram alert for a failure that is otherwise only logged (backgroundFailureAlert.ts). Optional so tests can omit it. */
  reportFailure?(source: string, message: string): void;
  reportRecovery?(source: string, message: string): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

function spotFromQuote(quote: WindowQuote): number | null {
  return quote.last ?? (quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : null);
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export const defaultDaySignalsLoopDependencies: DaySignalsLoopDependencies = {
  now: () => new Date(),
  isMarketOpen: async (now) => (await computeMarketSessionStatus(now)).state === "open",
  loadPool: loadDaySignalExpiries,
  loadUniverse: loadDaySignalUniverse,
  // Priority (approved 2026-09-24): the loop must keep its 10 lines for the
  // whole session, so like the chain capture it only has to fit alongside
  // other priority holders and live screens shed to it, never the reverse.
  reserveLines: (holder, lines, ttlSeconds) => reserveMarketDataLines(holder, lines, ttlSeconds, { priority: true }),
  releaseLines: releaseMarketDataLines,
  borrowLiveConnection: () => sharedLiveConnection.borrow(),
  allocateReqId: () => sharedLiveConnection.allocateReqId(),
  runQuoteWindow: runRollingQuoteWindow,
  runSpotPass: runRollingQuoteWindow,
  upsertDayQuotes,
  loadContractContexts: loadDayTickerContractContexts,
  loadUnpooledTickers: loadDayUnpooledTickers,
  pruneDayQuotes: pruneDayQuotesOutsideSet,
  replaceTickerPool: replaceTickerPoolExpiries,
  loadRerankStates: loadDayRerankStates,
  saveRerankState: saveDayRerankState,
  loadTickerSignalsInputs,
  loadAccountContext,
  loadSignalSettings,
  loadLastGrades: async (tickerId, tradingDateIso) => new Map((await loadDayQuotesForTicker(tickerId, tradingDateIso)).map((row) => [`${row.expiry}|${row.strike}|${row.right}`, row.lastGrade])),
  updateDayQuoteGrades,
  notifyUpgrade: notifySignalUpgrade,
  loadLastRollGrades: async (tickerId, tradingDateIso) => new Map((await loadDayRollGrades(tickerId, tradingDateIso)).map((row) => [`${row.legId}|${row.expiry}|${row.strike}|${row.right}`, row.lastGrade])),
  upsertRollGrades: upsertDayRollGrades,
  notifyRollUpgrade: notifyRollSignalUpgrade,
  loadAssignmentRiskAlertStates,
  recordAssignmentRiskAlert,
  rearmAssignmentRiskAlert,
  notifyAssignmentRisk,
  emitUpdated: emitDayQuotesUpdated,
  writeHeartbeat: async (status) => {
    await db("worker_health")
      .insert({
        process_name: "day_signals_loop",
        connected: status.state === "running",
        uptime_ms: Date.now() - new Date(status.stateSince).getTime(),
        total_reconnects: status.cycleNumber,
        git_sha: readGitSha(),
        app_environment: readAppEnvironment(),
        updated_at: db.fn.now(),
      })
      .onConflict("process_name")
      .merge();
  },
  sleep: sleepUnlessAborted,
  reportFailure: reportBackgroundFailure,
  reportRecovery: reportBackgroundRecovery,
};

export class DaySignalsLoop {
  private status: DaySignalsLoopStatus;
  private abort: AbortController | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private linesHeld = false;
  /** Per-contract notification cooldown state -- see daySignalsNotificationCooldownMs. Keyed
   * "signal:<tickerId>|<expiry>|<strike>|<right>" or "roll:<legId>|<expiry>|<strike>|<right>". */
  private lastNotifiedAtByKey = new Map<string, number>();

  constructor(private readonly deps: DaySignalsLoopDependencies = defaultDaySignalsLoopDependencies) {
    this.status = { state: "disabled", reason: "not started", stateSince: deps.now().toISOString(), tradingDateIso: null, cycleNumber: 0, cycleStartedAt: null, lastCycleDurationMs: null, contractsInPool: 0, lastError: null };
  }

  getStatus(): DaySignalsLoopStatus {
    return { ...this.status };
  }

  /** Runs until stop(); resolves when the loop has exited. */
  start(): Promise<void> {
    if (this.abort) throw new Error("DaySignalsLoop already started");
    this.abort = new AbortController();
    this.setState("idle", "starting");
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    return this.run(this.abort.signal);
  }

  stop(): void {
    this.abort?.abort();
  }

  private setState(state: DaySignalsLoopState, reason: string): void {
    const changed = this.status.state !== state || this.status.reason !== reason;
    if (!changed) return;
    this.status = { ...this.status, state, reason, stateSince: this.deps.now().toISOString() };
    console.log(`day signals loop: ${state} — ${reason}`);
    void this.heartbeat();
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.deps.writeHeartbeat(this.getStatus());
    } catch (error) {
      console.warn(`day signals loop: heartbeat failed — ${error instanceof Error ? error.message : error}`);
      this.deps.reportFailure?.("day-signals:heartbeat", `Day Signals loop could not write its heartbeat (${error instanceof Error ? error.message : error}). The health check will report the loop as down.`);
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        let ranCycle = false;
        try {
          ranCycle = await this.tick(signal);
        } catch (error) {
          this.status.lastError = error instanceof Error ? error.message : String(error);
          console.error(`day signals loop: ${this.status.lastError}`);
          this.deps.reportFailure?.("day-signals:cycle", `Day Signals loop failed: ${this.status.lastError}. It retries every 30 s; live Signals quotes are stale until it recovers.`);
          this.setState("idle", `error: ${this.status.lastError}`);
        }
        if (!ranCycle && !signal.aborted) await this.deps.sleep(stateCheckIntervalMs, signal);
      }
    } finally {
      await this.releaseLines();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.setState("disabled", "stopped");
    }
  }

  /** One state evaluation; returns true when a full cycle ran (so the next evaluation follows immediately). */
  private async tick(signal: AbortSignal): Promise<boolean> {
    const now = this.deps.now();
    const tradingDateIso = easternDateIso(now);
    if (!(await this.deps.isMarketOpen(now))) {
      await this.releaseLines();
      this.setState("idle", "market closed");
      return false;
    }
    const pool = await this.deps.loadPool(tradingDateIso);
    if (pool.length === 0) {
      await this.releaseLines();
      this.setState("idle", `waiting for today's pool (${tradingDateIso}: capture, fit and seed not done yet)`);
      return false;
    }
    if (!(await this.ensureLines())) return false;
    const universe = await this.deps.loadUniverse(tradingDateIso);
    if (universe.length === 0) {
      this.setState("idle", "today's pool has no captured contracts");
      return false;
    }
    let borrowed: { ib: IBApi };
    try {
      borrowed = await this.deps.borrowLiveConnection();
    } catch (error) {
      this.setState("idle", `IBKR live connection not ready (${error instanceof Error ? error.message : error})`);
      return false;
    }
    this.status.tradingDateIso = tradingDateIso;
    this.status.contractsInPool = universe.length;
    this.setState("running", `${pool.length} expiries, ${universe.length} contracts`);
    const result = await this.runCycle(borrowed.ib, pool, universe, tradingDateIso, signal);
    if (result.disconnected) {
      this.status.lastError = "IBKR live connection dropped mid-cycle";
      this.deps.reportFailure?.("day-signals:cycle", "Day Signals loop: the IBKR live connection dropped mid-cycle. It retries after a short pause.");
      await this.deps.sleep(afterDisconnectBackoffMs, signal);
    } else if (!signal.aborted) {
      this.deps.reportRecovery?.("day-signals:cycle", "Day Signals loop cycles are completing again");
    }
    return true;
  }

  private async ensureLines(): Promise<boolean> {
    const reservation = await this.deps.reserveLines(daySignalsLoopLineHolder, daySignalsLoopLines, lineReservationTtlSeconds);
    if (!reservation.ok) {
      this.linesHeld = false;
      this.setState(
        "idle",
        reservation.disabled
          ? "IBKR market-data lines disabled in this environment (IBKR_MARKET_DATA_LINES_ENABLED=false)"
          : `IBKR market-data lines unavailable (${reservation.availableLines} free${reservation.priorityLinesHeld > 0 ? ", a scheduled scan is running" : ""})`,
      );
      return false;
    }
    this.linesHeld = true;
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => {
        this.deps.reserveLines(daySignalsLoopLineHolder, daySignalsLoopLines, lineReservationTtlSeconds).catch((error) => {
          console.warn(`day signals loop: could not renew lines — ${error instanceof Error ? error.message : error}`);
          this.deps.reportFailure?.("day-signals:line-renew", `Day Signals loop could not renew its IBKR market-data lines (${error instanceof Error ? error.message : error}). Live screens may take them mid-session.`);
        });
      }, lineReservationRenewIntervalMs);
      this.renewTimer.unref?.();
    }
    return true;
  }

  private async releaseLines(): Promise<void> {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (!this.linesHeld) return;
    this.linesHeld = false;
    await this.deps.releaseLines(daySignalsLoopLineHolder).catch((error) => console.warn(`day signals loop: could not release lines — ${error instanceof Error ? error.message : error}`));
  }

  private async runCycle(ib: IBApi, pool: DaySignalExpiryRow[], snapshotUniverse: (DayQuoteContract & { symbol: string })[], tradingDateIso: string, signal: AbortSignal): Promise<RollingQuoteWindowResult> {
    const cycleNumber = ++this.status.cycleNumber;
    const startedAt = this.deps.now();
    this.status.cycleStartedAt = startedAt.toISOString();
    const [settings, account] = await Promise.all([this.deps.loadSignalSettings(), this.deps.loadAccountContext()]);

    // Spot pass: every pooled ticker's stock first, so the contract set below follows the live price.
    const spotByTicker = new Map<string, number | null>();
    // Tracked = pooled tickers plus tickers scored at 9:30 with no pool: a stock that jumped after the open may only now have puts worth selling.
    let trackedTickers = await this.trackedTickersFor(pool, tradingDateIso);
    const spotWindowContracts: WindowContract[] = trackedTickers.map((ticker) => ({ key: `${ticker.tickerId}|stock`, legType: "stock", symbol: ticker.symbol }));
    const spotPass = await this.deps.runSpotPass(spotWindowContracts, {
      ib,
      allocateReqId: this.deps.allocateReqId,
      concurrency: daySignalsLoopLines,
      timeoutMs: daySignalsContractTimeoutMs,
      signal,
      onSettled: (contract, quote) => spotByTicker.set(contract.key.split("|")[0]!, spotFromQuote(quote)),
      now: this.deps.now,
    });
    if (spotPass.disconnected || spotPass.aborted) return spotPass;

    let activePool = pool;
    let universe = snapshotUniverse;
    let contexts = await this.loadContractContextsSafely(trackedTickers, tradingDateIso);
    let poolChanged = false;
    const rerankedTickerIds = new Set<string>();
    const rerankStates = await this.loadRerankStatesSafely(tradingDateIso);
    for (const { tickerId } of trackedTickers) {
      const context = contexts.get(tickerId);
      const spot = spotByTicker.get(tickerId) ?? null;
      if (!context || spot === null || context.atmImpliedVolatility === null || context.snapshotSpotPrice === null || signal.aborted) continue;
      const state = rerankStates.get(tickerId) ?? { referenceSpotPrice: context.snapshotSpotPrice, reranks: 0 };
      if (!shouldRerankExpiries({ spotPrice: spot, referenceSpotPrice: state.referenceSpotPrice, atmImpliedVolatility: context.atmImpliedVolatility, reranksToday: state.reranks })) continue;
      // Counted and re-referenced whatever the outcome (and saved before the discovery runs): a failing discovery or a restart must not retry it.
      const nextState = { referenceSpotPrice: spot, reranks: state.reranks + 1 };
      rerankStates.set(tickerId, nextState);
      await this.deps.saveRerankState(tickerId, tradingDateIso, nextState).catch((error) => {
        console.warn(`day signals loop: could not save ${context.symbol}'s re-rank state — ${error instanceof Error ? error.message : error}`);
        this.deps.reportFailure?.("day-signals:rerank-state-save", `Day Signals loop could not save ${context.symbol}'s re-rank state (${error instanceof Error ? error.message : error}).`);
      });
      const outcome = await this.rerankTicker(ib, context, spot, tradingDateIso, settings, account, signal);
      if (outcome === "disconnected") return { settled: 0, disconnected: true, aborted: false };
      if (outcome === "changed") {
        poolChanged = true;
        rerankedTickerIds.add(tickerId);
      }
    }
    if (poolChanged) {
      [activePool, universe] = await Promise.all([this.deps.loadPool(tradingDateIso), this.deps.loadUniverse(tradingDateIso)]);
      trackedTickers = await this.trackedTickersFor(activePool, tradingDateIso);
      contexts = await this.loadContractContextsSafely(trackedTickers, tradingDateIso);
    }
    const built = await this.buildCycleUniverse(activePool, universe, contexts, spotByTicker, rerankedTickerIds);
    universe = built.universe;
    const newContractKeysByTicker = built.newContractKeysByTicker;
    this.status.contractsInPool = universe.length;

    // ticker → its contracts, in universe order; each block ends with the ticker's stock slot.
    const tickers = new Map<string, { symbol: string; contracts: (DayQuoteContract & { symbol: string })[] }>();
    for (const contract of universe) {
      const entry = tickers.get(contract.tickerId) ?? { symbol: contract.symbol, contracts: [] };
      entry.contracts.push(contract);
      tickers.set(contract.tickerId, entry);
    }
    const windowContracts: WindowContract[] = [];
    const remainingByTicker = new Map<string, number>();
    for (const [tickerId, entry] of tickers) {
      for (const contract of entry.contracts) {
        windowContracts.push({ key: `${tickerId}|${contract.expiry}|${contract.strike}|${contract.right}`, legType: "option", symbol: entry.symbol, expiry: formatIsoDateAsExpiry(contract.expiry), strike: contract.strike, right: contract.right });
      }
      windowContracts.push({ key: `${tickerId}|stock`, legType: "stock", symbol: entry.symbol });
      remainingByTicker.set(tickerId, entry.contracts.length + 1);
    }

    let writeBuffer: DayQuoteWrite[] = [];
    let flushChain: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> => {
      if (writeBuffer.length === 0) return flushChain;
      const batch = writeBuffer;
      writeBuffer = [];
      flushChain = flushChain.then(() => this.deps.upsertDayQuotes(batch)).catch((error) => {
        console.error(`day signals loop: quote write failed — ${error instanceof Error ? error.message : error}`);
        this.deps.reportFailure?.("day-signals:quote-write", `Day Signals loop could not save its quotes (${error instanceof Error ? error.message : error}). Live Signals quotes are stale.`);
      });
      return flushChain;
    };
    const flushTimer = setInterval(() => void flush(), writeFlushIntervalMs);
    let tickerWorkChain: Promise<void> = Promise.resolve();

    const onSettled = (contract: WindowContract, quote: WindowQuote): void => {
      const tickerId = contract.key.split("|")[0]!;
      if (contract.legType === "option") {
        const [, expiry, strike, right] = contract.key.split("|") as [string, string, string, "C" | "P"];
        writeBuffer.push({ tickerId, expiry, strike: Number(strike), right, tradingDateIso, bid: quote.bid, ask: quote.ask, last: quote.last, errorCode: quote.errorCode, quotedAt: quote.settledAt, cycleNumber });
        if (writeBuffer.length >= writeFlushRowCount) void flush();
      } else {
        spotByTicker.set(tickerId, spotFromQuote(quote));
      }
      const remaining = (remainingByTicker.get(tickerId) ?? 1) - 1;
      remainingByTicker.set(tickerId, remaining);
      if (remaining === 0) {
        const symbol = tickers.get(tickerId)!.symbol;
        tickerWorkChain = tickerWorkChain.then(async () => {
          await flush();
          await this.rescoreTicker({ tickerId, symbol, companyName: null, sector: null }, tradingDateIso, spotByTicker.get(tickerId) ?? null, settings, account, newContractKeysByTicker.get(tickerId) ?? new Set());
        });
      }
    };

    try {
      const result = await this.deps.runQuoteWindow(windowContracts, { ib, allocateReqId: this.deps.allocateReqId, concurrency: daySignalsLoopLines, timeoutMs: daySignalsContractTimeoutMs, signal, onSettled, now: this.deps.now });
      await flush();
      await tickerWorkChain;
      this.status.lastCycleDurationMs = this.deps.now().getTime() - startedAt.getTime();
      console.log(`day signals loop: cycle ${cycleNumber} — ${result.settled}/${windowContracts.length} settled in ${Math.round(this.status.lastCycleDurationMs / 1000)}s${result.disconnected ? " (disconnected)" : ""}${result.aborted ? " (aborted)" : ""}`);
      return result;
    } finally {
      clearInterval(flushTimer);
    }
  }

  /** The pooled tickers (from the pool rows), then the unpooled scored ones; an unavailable unpooled list leaves just the pooled. */
  private async trackedTickersFor(pool: DaySignalExpiryRow[], tradingDateIso: string): Promise<DayTrackedTicker[]> {
    const tracked = new Map<string, DayTrackedTicker>();
    for (const row of pool) if (!tracked.has(row.tickerId)) tracked.set(row.tickerId, { tickerId: row.tickerId, symbol: row.symbol, snapshotId: row.snapshotId });
    try {
      for (const ticker of await this.deps.loadUnpooledTickers(tradingDateIso)) if (!tracked.has(ticker.tickerId)) tracked.set(ticker.tickerId, ticker);
    } catch (error) {
      console.warn(`day signals loop: unpooled tickers unavailable, tracking pooled ones only — ${error instanceof Error ? error.message : error}`);
      this.deps.reportFailure?.("day-signals:unpooled-tickers", `Day Signals loop could not read the unpooled tickers (${error instanceof Error ? error.message : error}), so only pooled tickers are being tracked.`);
    }
    return [...tracked.values()];
  }

  private async loadRerankStatesSafely(tradingDateIso: string): Promise<Map<string, DayRerankState>> {
    try {
      return await this.deps.loadRerankStates(tradingDateIso);
    } catch (error) {
      console.warn(`day signals loop: re-rank state unavailable, assuming none — ${error instanceof Error ? error.message : error}`);
      this.deps.reportFailure?.("day-signals:rerank-state", `Day Signals loop could not read its re-rank state (${error instanceof Error ? error.message : error}), so it assumes none.`);
      return new Map();
    }
  }

  /** A failed context load leaves every ticker on the snapshot's contracts for this cycle rather than stopping the loop. */
  private async loadContractContextsSafely(trackedTickers: DayTrackedTicker[], tradingDateIso: string): Promise<Map<string, DayTickerContractContext>> {
    try {
      return await this.deps.loadContractContexts(trackedTickers, tradingDateIso);
    } catch (error) {
      console.warn(`day signals loop: contract contexts unavailable, using the snapshot's contracts — ${error instanceof Error ? error.message : error}`);
      this.deps.reportFailure?.("day-signals:contract-contexts", `Day Signals loop could not read its contract contexts (${error instanceof Error ? error.message : error}), so it quotes the morning snapshot's contracts only.`);
      return new Map();
    }
  }

  /**
   * The cycle's contracts: per ticker with a live spot, ATM IV and stored strike grids, the capture's rule at that spot for every
   * pooled expiry it can window (and its stored quotes outside that set are deleted); anything else stays on the snapshot's contracts.
   */
  private async buildCycleUniverse(pool: DaySignalExpiryRow[], snapshotUniverse: (DayQuoteContract & { symbol: string })[], contexts: Map<string, DayTickerContractContext>, spotByTicker: Map<string, number | null>, rerankedTickerIds: Set<string>): Promise<{ universe: (DayQuoteContract & { symbol: string })[]; newContractKeysByTicker: Map<string, Set<string>> }> {
    const universe: (DayQuoteContract & { symbol: string })[] = [];
    const newContractKeysByTicker = new Map<string, Set<string>>();
    const prunes: Promise<void>[] = [];
    const tickerIds = [...new Set(pool.map((row) => row.tickerId))];
    for (const tickerId of tickerIds) {
      const symbol = pool.find((row) => row.tickerId === tickerId)!.symbol;
      const snapshotContracts = snapshotUniverse.filter((contract) => contract.tickerId === tickerId);
      const context = contexts.get(tickerId);
      const spot = spotByTicker.get(tickerId) ?? null;
      if (!context || spot === null || !(spot > 0) || context.atmImpliedVolatility === null) {
        universe.push(...snapshotContracts);
        continue;
      }
      const windowable: DayContractSetExpiry[] = [];
      const snapshotOnlyExpiries = new Set<string>();
      for (const row of pool.filter((entry) => entry.tickerId === tickerId)) {
        const strikes = context.strikesByExpiry.get(row.expiry);
        const window = strikes ? computeStrikeWindow({ spotPrice: spot, atmImpliedVolatility: context.atmImpliedVolatility, daysToExpiry: calendarDaysUntilExpiry(row.tradingDateIso, row.expiry.replaceAll("-", "")) }) : null;
        if (strikes && window) windowable.push({ expiry: row.expiry, strikes, window });
        else snapshotOnlyExpiries.add(row.expiry);
      }
      const dynamic = selectDaySignalContractSet({ expiries: windowable, spotPrice: spot, previousContracts: context.previousContracts, heldContracts: context.heldContracts });
      const kept = [...dynamic, ...snapshotContracts.filter((contract) => snapshotOnlyExpiries.has(contract.expiry))].sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.right.localeCompare(b.right));
      if (kept.length === 0) {
        universe.push(...snapshotContracts);
        continue;
      }
      universe.push(...kept.map((contract) => ({ tickerId, symbol, expiry: contract.expiry, strike: contract.strike, right: contract.right })));
      // Contracts the loop starts quoting mid-day (the price moved, or a re-rank added an expiry): with quotes stored from an earlier
      // cycle, so the very first cycle after the seed (nothing stored) stays a baseline. Their first grade can notify.
      // A ticker pooled by a re-rank this cycle has nothing stored yet, but everything it quotes is new to the loop.
      if (context.previousContracts.length > 0 || rerankedTickerIds.has(tickerId)) {
        const previousKeys = new Set(context.previousContracts.map((contract) => `${contract.expiry}|${contract.strike}|${contract.right}`));
        newContractKeysByTicker.set(tickerId, new Set(kept.map((contract) => `${contract.expiry}|${contract.strike}|${contract.right}`).filter((key) => !previousKeys.has(key))));
      }
      prunes.push(this.deps.pruneDayQuotes(tickerId, kept).catch((error) => console.warn(`day signals loop: pruning ${symbol}'s dropped contracts failed — ${error instanceof Error ? error.message : error}`)));
    }
    await Promise.all(prunes);
    return { universe, newContractKeysByTicker };
  }

  /** One-off discovery for a ticker whose spot moved: quote the capture's contract set at the new spot across all its fitted expiries, score, and re-pick the pooled expiries (open legs' expiries always stay). */
  private async rerankTicker(ib: IBApi, context: DayTickerContractContext, spot: number, tradingDateIso: string, settings: SignalSettings, account: AccountContext, signal: AbortSignal): Promise<"changed" | "unchanged" | "disconnected"> {
    try {
      const inputs = await this.deps.loadTickerSignalsInputs({ tickerId: context.tickerId, symbol: context.symbol, companyName: null, sector: null });
      if (!inputs.header || inputs.header.tradingDateIso !== tradingDateIso || context.atmImpliedVolatility === null) return "unchanged";
      const fittedExpiries = new Set(inputs.slices.filter((slice) => slice.status === "ok" && slice.parameters).map((slice) => slice.expiry));
      const contracts: WindowContract[] = [];
      for (const [expiry, strikes] of context.strikesByExpiry) {
        if (!fittedExpiries.has(expiry)) continue;
        const window = computeStrikeWindow({ spotPrice: spot, atmImpliedVolatility: context.atmImpliedVolatility, daysToExpiry: calendarDaysUntilExpiry(tradingDateIso, expiry.replaceAll("-", "")) });
        if (!window) continue;
        for (const contract of selectContractsToCapture(strikes, spot, window)) {
          contracts.push({ key: `${context.tickerId}|${expiry}|${contract.strike}|${contract.right}`, legType: "option", symbol: context.symbol, expiry: formatIsoDateAsExpiry(expiry), strike: contract.strike, right: contract.right });
        }
      }
      if (contracts.length === 0) return "unchanged";
      const freshQuotes: LiveOptionQuote[] = [];
      const result = await this.deps.runQuoteWindow(contracts, {
        ib,
        allocateReqId: this.deps.allocateReqId,
        concurrency: daySignalsLoopLines,
        timeoutMs: daySignalsContractTimeoutMs,
        signal,
        onSettled: (contract, quote) => {
          const [, expiry, strike, right] = contract.key.split("|") as [string, string, string, "C" | "P"];
          freshQuotes.push({ expiry, strike: Number(strike), right, bid: quote.bid, ask: quote.ask, quotedAt: quote.settledAt.toISOString() });
        },
        now: this.deps.now,
      });
      if (result.disconnected) return "disconnected";
      if (result.aborted) return "unchanged";
      const scored = scoreTicker(inputs, account, settings, { spotPrice: spot, priceSource: "live", liveQuotes: freshQuotes });
      // Only contracts quoted in this pass: a snapshot-priced candidate from before the move would rank on a stale price.
      const candidates = scored.candidates.filter((candidate) => candidate.quoteSource === "live");
      const snapshotExpiries = new Set(inputs.slices.map((slice) => slice.expiry));
      const heldLegExpiries = inputs.openShortLegs.map((leg) => leg.expiry).filter((expiry) => snapshotExpiries.has(expiry));
      const expiries = selectDaySignalExpiries(candidates, undefined, heldLegExpiries);
      // No positive-Edge candidate anywhere: keep the pool as it is rather than emptying a ticker mid-session.
      if (expiries.length === 0) return "unchanged";
      const changed = await this.deps.replaceTickerPool(context.tickerId, tradingDateIso, context.snapshotId, expiries, this.deps.now());
      if (changed) console.log(`day signals loop: re-ranked ${context.symbol} at ${spot} — pooled expiries ${expiries.map((entry) => entry.expiry).join(", ")}`);
      return changed ? "changed" : "unchanged";
    } catch (error) {
      console.error(`day signals loop: re-rank of ${context.symbol} failed — ${error instanceof Error ? error.message : error}`);
      this.deps.reportFailure?.("day-signals:rerank", `Day Signals re-rank of ${context.symbol} failed (${error instanceof Error ? error.message : error}). Other tickers may be affected too; this alert repeats at most hourly.`);
      return "unchanged";
    }
  }

  /** True when `key` has never notified, or last did at least daySignalsNotificationCooldownMs ago. */
  private canNotify(key: string): boolean {
    const lastNotifiedAt = this.lastNotifiedAtByKey.get(key);
    return lastNotifiedAt === undefined || this.deps.now().getTime() - lastNotifiedAt >= daySignalsNotificationCooldownMs;
  }

  private markNotified(key: string): void {
    this.lastNotifiedAtByKey.set(key, this.deps.now().getTime());
  }

  private async rescoreTicker(ticker: SignalsTickerRow, tradingDateIso: string, spot: number | null, settings: SignalSettings, account: AccountContext, newContractKeys: Set<string>): Promise<void> {
    try {
      const [inputs, lastGrades, lastRollGrades] = await Promise.all([this.deps.loadTickerSignalsInputs(ticker), this.deps.loadLastGrades(ticker.tickerId, tradingDateIso), this.deps.loadLastRollGrades(ticker.tickerId, tradingDateIso)]);
      if (!inputs.header || inputs.header.tradingDateIso !== tradingDateIso) return;
      const scored = scoreTicker(inputs, account, settings, spot !== null ? { spotPrice: spot, priceSource: "live" } : undefined);
      // Roll Signals: same upward-only rule per (held leg, replacement); the first score after a seed or restart is a baseline.
      const heldByLegId = new Map(scored.heldLegs.map((leg) => [leg.legId, leg]));
      const rollGrades: { legId: string; expiry: string; strike: number; right: "C" | "P"; grade: SignalGrade }[] = [];
      for (const roll of scored.rolls) {
        const key = rollCandidateKey(roll);
        // A replacement contract the loop only just started quoting has no recorded grade: it counts as coming from Avoid, not as a baseline.
        const storedRollGrade = lastRollGrades.get(key) ?? null;
        const previousGrade = storedRollGrade === null && newContractKeys.has(`${roll.replacement.expiry}|${roll.replacement.strike}|${roll.strategyKey === "covered_call" ? "C" : "P"}`) ? "avoid" : storedRollGrade;
        const held = heldByLegId.get(roll.legId);
        const notificationKey = `roll:${key}`;
        if (held && isGradeUpgrade(previousGrade, roll.grade) && clearsNotificationHysteresis(roll.grade, roll.netRollEdge) && this.canNotify(notificationKey)) {
          await this.deps.notifyRollUpgrade({ symbol: ticker.symbol, roll, held: { strike: held.strike, expiry: held.expiry, dte: held.dte }, previousGrade: previousGrade!, spotPrice: scored.spotPrice ?? spot ?? 0, quotedAt: roll.replacement.quotedAt });
          this.markNotified(notificationKey);
        }
        rollGrades.push({ legId: roll.legId, expiry: roll.replacement.expiry, strike: roll.replacement.strike, right: roll.strategyKey === "covered_call" ? "C" : "P", grade: roll.grade });
      }
      await this.deps.upsertRollGrades(ticker.tickerId, tradingDateIso, rollGrades);
      const grades: { expiry: string; strike: number; right: "C" | "P"; grade: SignalGrade }[] = [];
      for (const candidate of scored.candidates) {
        const key = candidateContractKey(candidate);
        if (!lastGrades.has(key)) continue; // not a pooled contract
        // Same for a newly quoted contract: no recorded grade, but not a baseline either.
        const storedGrade = lastGrades.get(key) ?? null;
        const previousGrade = storedGrade === null && newContractKeys.has(key) ? "avoid" : storedGrade;
        const notificationKey = `signal:${ticker.tickerId}|${key}`;
        if (isGradeUpgrade(previousGrade, candidate.grade) && clearsNotificationHysteresis(candidate.grade, candidate.netEdge) && this.canNotify(notificationKey)) {
          await this.deps.notifyUpgrade({ symbol: ticker.symbol, candidate, previousGrade: previousGrade!, spotPrice: scored.spotPrice ?? spot ?? 0, quotedAt: candidate.quotedAt });
          this.markNotified(notificationKey);
        }
        grades.push({ expiry: candidate.expiry, strike: candidate.strike, right: candidate.strategyKey === "covered_call" ? "C" : "P", grade: candidate.grade });
      }
      await this.deps.updateDayQuoteGrades(ticker.tickerId, grades);
      this.deps.emitUpdated(ticker.tickerId);
      await this.checkAssignmentRisk(ticker.symbol, scored.heldLegs, tradingDateIso, scored.spotPrice ?? spot);
    } catch (error) {
      console.error(`day signals loop: re-score of ${ticker.symbol} failed — ${error instanceof Error ? error.message : error}`);
      this.deps.reportFailure?.("day-signals:rescore", `Day Signals re-score of ${ticker.symbol} failed (${error instanceof Error ? error.message : error}), so its grades and upgrade notifications are not updating. Other tickers may be affected too.`);
    }
  }

  /** Alerts held legs whose |delta| reached assignment risk, and re-arms flagged ones that fell back (decideAssignmentRiskAlert). Unscored legs (no delta) are skipped. */
  private async checkAssignmentRisk(symbol: string, heldLegs: HeldLegScore[], tradingDateIso: string, spotPrice: number | null): Promise<void> {
    const scoredLegs = heldLegs.filter((leg): leg is HeldLegScore & { delta: number } => leg.delta !== null);
    if (scoredLegs.length === 0) return;
    const states = await this.deps.loadAssignmentRiskAlertStates(scoredLegs.map((leg) => leg.legId));
    for (const leg of scoredLegs) {
      const state = states.get(leg.legId);
      if (!state) continue; // leg closed since the inputs were loaded
      const decision = decideAssignmentRiskAlert(leg.delta, state, tradingDateIso);
      if (decision === "rearm") await this.deps.rearmAssignmentRiskAlert(leg.legId);
      if (decision === "alert") {
        // Recorded before notifying: a failed write must not turn into a re-alert every cycle.
        await this.deps.recordAssignmentRiskAlert(leg.legId, tradingDateIso);
        await this.deps.notifyAssignmentRisk({ symbol, leg, spotPrice });
      }
    }
  }
}

let runningLoop: DaySignalsLoop | null = null;

/** Started once by server.ts when DAY_SIGNALS_LOOP_ENABLED=true; the health route reads its status. */
export function startDaySignalsLoop(): DaySignalsLoop {
  if (runningLoop) return runningLoop;
  runningLoop = new DaySignalsLoop();
  runningLoop.start().catch((error) => {
    console.error(`day signals loop exited: ${error instanceof Error ? error.message : error}`);
    reportBackgroundFailure("day-signals:loop-exited", `🔥 Day Signals loop exited and will not restart until the web dyno does: ${error instanceof Error ? error.message : error}`);
  });
  return runningLoop;
}

export function daySignalsLoopStatus(): DaySignalsLoopStatus | null {
  return runningLoop?.getStatus() ?? null;
}
