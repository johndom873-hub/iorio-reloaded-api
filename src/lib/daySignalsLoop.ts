import type { IBApi } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { runRollingQuoteWindow, type RollingQuoteWindowOptions, type RollingQuoteWindowResult, type WindowContract, type WindowQuote } from "../ibkr/daySignalsQuoteWindow.js";
import { releaseMarketDataLines, reserveMarketDataLines, type LineReservationResult } from "../ibkr/marketDataLineBudget.js";
import { sharedLiveConnection } from "../ibkr/sharedReadConnection.js";
import { readAppEnvironment } from "./appEnvironment.js";
import { emitDayQuotesUpdated } from "./daySignalsEvents.js";
import { isGradeUpgrade, notifySignalUpgrade, type SignalUpgrade } from "./daySignalsNotifications.js";
import { loadDaySignalExpiries, loadDaySignalUniverse, loadDayQuotesForTicker, updateDayQuoteGrades, upsertDayQuotes, type DayQuoteContract, type DayQuoteWrite, type DaySignalExpiryRow } from "./daySignalsStore.js";
import { computeMarketSessionStatus, easternDateIso } from "./marketSessionStatus.js";
import { formatIsoDateAsExpiry } from "./optionChainSnapshotStore.js";
import { readGitSha } from "./readGitSha.js";
import type { SignalGrade } from "./signalCandidates.js";
import { candidateContractKey, scoreTicker } from "./signalsLiveScoring.js";
import { loadAccountContext, loadTickerSignalsInputs, type ShortlistTickerRow } from "./signalsStore.js";
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
// After every ticker's block settles: its quotes are flushed, the ticker is
// re-scored exactly as the screens score it (scoreTicker over the merged
// day quotes), upward grade transitions vs day_signal_quotes.last_grade
// are notified, and dayQuotesUpdated fires so open Signals streams reload.

export const daySignalsLoopLineHolder = "daySignalsLoop";
export const daySignalsLoopLines = 10;
const lineReservationTtlSeconds = 90;
const lineReservationRenewIntervalMs = 60_000;
const stateCheckIntervalMs = 30_000;
const afterDisconnectBackoffMs = 5_000;
const heartbeatIntervalMs = 60_000;
// Assumptions to verify on the staging soak (PROGRESS.md): per-contract settle timeout, write batching.
export const daySignalsContractTimeoutMs = 4_000;
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
  upsertDayQuotes(writes: DayQuoteWrite[]): Promise<void>;
  loadTickerSignalsInputs(ticker: ShortlistTickerRow): Promise<TickerSignalsInputs>;
  loadAccountContext(): Promise<AccountContext>;
  loadSignalSettings(): Promise<SignalSettings>;
  loadLastGrades(tickerId: string, tradingDateIso: string): Promise<Map<string, SignalGrade | null>>;
  updateDayQuoteGrades(tickerId: string, grades: { expiry: string; strike: number; right: "C" | "P"; grade: SignalGrade }[]): Promise<void>;
  notifyUpgrade(upgrade: SignalUpgrade): Promise<void>;
  emitUpdated(tickerId: string): void;
  writeHeartbeat(status: DaySignalsLoopStatus): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
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
  upsertDayQuotes,
  loadTickerSignalsInputs,
  loadAccountContext,
  loadSignalSettings,
  loadLastGrades: async (tickerId, tradingDateIso) => new Map((await loadDayQuotesForTicker(tickerId, tradingDateIso)).map((row) => [`${row.expiry}|${row.strike}|${row.right}`, row.lastGrade])),
  updateDayQuoteGrades,
  notifyUpgrade: notifySignalUpgrade,
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
};

export class DaySignalsLoop {
  private status: DaySignalsLoopStatus;
  private abort: AbortController | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private linesHeld = false;

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
    const result = await this.runCycle(borrowed.ib, universe, tradingDateIso, signal);
    if (result.disconnected) {
      this.status.lastError = "IBKR live connection dropped mid-cycle";
      await this.deps.sleep(afterDisconnectBackoffMs, signal);
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
        this.deps.reserveLines(daySignalsLoopLineHolder, daySignalsLoopLines, lineReservationTtlSeconds).catch((error) => console.warn(`day signals loop: could not renew lines — ${error instanceof Error ? error.message : error}`));
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

  private async runCycle(ib: IBApi, universe: (DayQuoteContract & { symbol: string })[], tradingDateIso: string, signal: AbortSignal): Promise<RollingQuoteWindowResult> {
    const cycleNumber = ++this.status.cycleNumber;
    const startedAt = this.deps.now();
    this.status.cycleStartedAt = startedAt.toISOString();
    const [settings, account] = await Promise.all([this.deps.loadSignalSettings(), this.deps.loadAccountContext()]);

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

    const spotByTicker = new Map<string, number | null>();
    let writeBuffer: DayQuoteWrite[] = [];
    let flushChain: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> => {
      if (writeBuffer.length === 0) return flushChain;
      const batch = writeBuffer;
      writeBuffer = [];
      flushChain = flushChain.then(() => this.deps.upsertDayQuotes(batch)).catch((error) => console.error(`day signals loop: quote write failed — ${error instanceof Error ? error.message : error}`));
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
        spotByTicker.set(tickerId, quote.last ?? (quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : null));
      }
      const remaining = (remainingByTicker.get(tickerId) ?? 1) - 1;
      remainingByTicker.set(tickerId, remaining);
      if (remaining === 0) {
        const symbol = tickers.get(tickerId)!.symbol;
        tickerWorkChain = tickerWorkChain.then(async () => {
          await flush();
          await this.rescoreTicker({ tickerId, symbol, companyName: null, sector: null }, tradingDateIso, spotByTicker.get(tickerId) ?? null, settings, account);
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

  private async rescoreTicker(ticker: ShortlistTickerRow, tradingDateIso: string, spot: number | null, settings: SignalSettings, account: AccountContext): Promise<void> {
    try {
      const [inputs, lastGrades] = await Promise.all([this.deps.loadTickerSignalsInputs(ticker), this.deps.loadLastGrades(ticker.tickerId, tradingDateIso)]);
      if (!inputs.header || inputs.header.tradingDateIso !== tradingDateIso) return;
      const scored = scoreTicker(inputs, account, settings, spot !== null ? { spotPrice: spot, priceSource: "live" } : undefined);
      const grades: { expiry: string; strike: number; right: "C" | "P"; grade: SignalGrade }[] = [];
      for (const candidate of scored.candidates) {
        const key = candidateContractKey(candidate);
        if (!lastGrades.has(key)) continue; // not a pooled contract
        const previousGrade = lastGrades.get(key) ?? null;
        if (isGradeUpgrade(previousGrade, candidate.grade)) {
          await this.deps.notifyUpgrade({ symbol: ticker.symbol, candidate, previousGrade: previousGrade!, spotPrice: scored.spotPrice ?? spot ?? 0, quotedAt: candidate.quotedAt });
        }
        grades.push({ expiry: candidate.expiry, strike: candidate.strike, right: candidate.strategyKey === "covered_call" ? "C" : "P", grade: candidate.grade });
      }
      await this.deps.updateDayQuoteGrades(ticker.tickerId, grades);
      this.deps.emitUpdated(ticker.tickerId);
    } catch (error) {
      console.error(`day signals loop: re-score of ${ticker.symbol} failed — ${error instanceof Error ? error.message : error}`);
    }
  }
}

let runningLoop: DaySignalsLoop | null = null;

/** Started once by server.ts when DAY_SIGNALS_LOOP_ENABLED=true; the health route reads its status. */
export function startDaySignalsLoop(): DaySignalsLoop {
  if (runningLoop) return runningLoop;
  runningLoop = new DaySignalsLoop();
  runningLoop.start().catch((error) => console.error(`day signals loop exited: ${error instanceof Error ? error.message : error}`));
  return runningLoop;
}

export function daySignalsLoopStatus(): DaySignalsLoopStatus | null {
  return runningLoop?.getStatus() ?? null;
}
