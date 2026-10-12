import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { LiveOptionQuote, LiveScoringOverrides } from "../../lib/signalsLiveScoring.js";
import type { OpenShortLeg } from "../../lib/rollSignalCandidates.js";
import type { TickerSignals, TickerSignalsInputs } from "../../lib/signalsTypes.js";
import type { TradingSettings } from "../../lib/tradingSettingsStore.js";
import type { VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import type { MacroEvent } from "../../lib/macroEventCalendar.js";
import type { ElevatedVolatilityFlag } from "../../lib/tiltMeasures.js";
import type { StoredDailyBar } from "./backtestBarHistory.js";
import type { SymbolFileDay } from "./backtestSymbolFile.js";
import type { BacktestDayMarket, BacktestTickerProfile } from "./backtestTickerInputs.js";
import type { MarketCalendarRow } from "./backtestTradingCalendar.js";

// Scoring a look's symbols in parallel (Marcelo 2026-10-12): the two heavy steps of a symbol's look, building the day's
// Signals inputs (the surface fit among them) and scoring the ticker, run in worker threads, one symbol always on the
// same worker, which keeps its bars and its inputs of the day. Everything that reads or changes the shared book (the
// filters, the close offers, the choice, the gates, the fills) stays on the session's thread, in the same order as
// without the pool: the results are the same, only the wall time changes. Used by rules-mode sessions of two or more
// symbols; an LLM-mode session stays on one thread.

/** At most one worker per symbol and per core: a look waits for its slowest symbol. */
export function scoringWorkerCount(symbolCount: number): number {
  return Math.min(symbolCount, availableParallelism());
}

/** Scoring a symbol's look on its inputs of the day, with the book's figures of the pass ("warm": the same, ahead of time, result dropped). */
interface BacktestScoringRequestBody {
  symbol: string;
  todayIso: string;
  freeShares: number;
  openShortLegs: OpenShortLeg[];
  dayQuotes: LiveOptionQuote[];
  /** A score only: true when its day quotes are the ones the symbol's last warm request carried (sent empty then, read from the worker's copy). */
  dayQuotesOfLastWarm?: boolean;
  freeCash: number;
  trading: TradingSettings;
  live: LiveScoringOverrides;
  modelTablesId: number;
  /** Sent the first time a worker needs these tables. */
  modelTables: VolatilityModelTables | null;
  scoredAtMs: number;
}

export type BacktestScoringWorkerRequest =
  | {
      type: "init";
      calendar: { fileDays: readonly SymbolFileDay[]; marketCalendarRows: readonly MarketCalendarRow[] };
      symbols: { symbol: string; profile: BacktestTickerProfile; barRows: readonly StoredDailyBar[] }[];
    }
  | { type: "prepareDay"; symbol: string; splitFactor: number; market: BacktestDayMarket; elevatedVolatility?: ElevatedVolatilityFlag | null; macroEvents?: readonly MacroEvent[] }
  | (BacktestScoringRequestBody & { type: "score" })
  | (BacktestScoringRequestBody & { type: "warm" });

export type BacktestScoringWorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

type PrepareDayRequest = Omit<Extract<BacktestScoringWorkerRequest, { type: "prepareDay" }>, "type">;
type PreparedDay = { inputs: TickerSignalsInputs; fitIssue: string | null; referenceVolatility: number | null };

export interface BacktestScoringPoolSetup {
  calendar: { fileDays: readonly SymbolFileDay[]; marketCalendarRows: readonly MarketCalendarRow[] };
  symbols: { symbol: string; profile: BacktestTickerProfile; barRows: readonly StoredDailyBar[] }[];
  workerCount: number;
}

/** A worker module of the engine (next to this one) by its base name: the TypeScript source under tsx, the compiled file otherwise. */
export function engineWorkerModuleUrl(baseName: string): URL {
  return new URL(import.meta.url.endsWith(".ts") ? `./${baseName}.ts` : `./${baseName}.js`, import.meta.url);
}

/** A worker runs the TypeScript source through tsx as this process does; a process not started through tsx (a test runner) registers it. */
export function engineWorkerExecArgv(): string[] | undefined {
  if (!import.meta.url.endsWith(".ts")) return undefined;
  return process.execArgv.some((argument) => argument.includes("tsx")) ? undefined : ["--import", "tsx"];
}

interface PoolWorker {
  worker: Worker;
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>;
  modelTablesIds: Set<number>;
}

export class BacktestScoringPool {
  private readonly workers: PoolWorker[];
  private readonly workerBySymbol = new Map<string, PoolWorker>();
  private readonly modelTablesIds = new WeakMap<VolatilityModelTables, number>();
  /** Each symbol's last scoring request as sent, for warm(). */
  private readonly lastScoreRequestBySymbol = new Map<string, Extract<BacktestScoringWorkerRequest, { type: "score" }>>();
  /** Days built ahead (prepareDayAhead), by symbol and day. */
  private readonly preparedAheadByKey = new Map<string, { request: PrepareDayRequest; prepared: Promise<PreparedDay> }>();
  /** The day quotes each symbol's last warm request carried, as this thread holds them. */
  private readonly lastWarmDayQuotesBySymbol = new Map<string, LiveOptionQuote[]>();
  private nextRequestId = 1;
  private failure: Error | null = null;

  constructor(setup: BacktestScoringPoolSetup) {
    if (setup.workerCount < 1) throw new Error("A scoring pool needs at least one worker.");
    this.workers = Array.from({ length: setup.workerCount }, () => {
      const poolWorker: PoolWorker = { worker: new Worker(engineWorkerModuleUrl("backtestScoringWorker"), { execArgv: engineWorkerExecArgv() }), pending: new Map(), modelTablesIds: new Set() };
      poolWorker.worker.on("message", (reply: BacktestScoringWorkerReply) => {
        const waiting = poolWorker.pending.get(reply.id);
        if (!waiting) return;
        poolWorker.pending.delete(reply.id);
        if (reply.ok) waiting.resolve(reply.result);
        else waiting.reject(new Error(`Scoring worker: ${reply.error}`));
      });
      const failAll = (error: Error) => {
        this.failure ??= error;
        for (const waiting of poolWorker.pending.values()) waiting.reject(error);
        poolWorker.pending.clear();
      };
      poolWorker.worker.on("error", (error) => failAll(new Error(`Scoring worker failed: ${error.message}`)));
      poolWorker.worker.on("exit", (exitCode) => failAll(new Error(`Scoring worker exited with code ${exitCode}.`)));
      return poolWorker;
    });
    // Symbols in session order, one worker after the other.
    setup.symbols.forEach((entry, index) => this.workerBySymbol.set(entry.symbol, this.workers[index % this.workers.length]!));
    for (const poolWorker of this.workers) {
      const symbols = setup.symbols.filter((entry) => this.workerBySymbol.get(entry.symbol) === poolWorker);
      void this.send(poolWorker, { type: "init", calendar: setup.calendar, symbols }).catch(() => {});
    }
  }

  get workerCount(): number {
    return this.workers.length;
  }

  private send(poolWorker: PoolWorker, request: BacktestScoringWorkerRequest): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      poolWorker.pending.set(id, { resolve, reject });
      poolWorker.worker.postMessage({ id, request });
    });
  }

  private workerOf(symbol: string): PoolWorker {
    const poolWorker = this.workerBySymbol.get(symbol);
    if (!poolWorker) throw new Error(`The scoring pool was not given ${symbol}.`);
    return poolWorker;
  }

  /** buildHistoricalTickerInputs on the symbol's worker, which keeps the inputs for the day's scoring. */
  async prepareDay(request: PrepareDayRequest): Promise<PreparedDay> {
    const key = `${request.symbol}|${request.market.todayIso}`;
    const ahead = this.preparedAheadByKey.get(key);
    this.preparedAheadByKey.delete(key);
    // The day built ahead serves only the same request: the same market and macro events (the very objects), split factor and flag.
    if (ahead && ahead.request.market === request.market && ahead.request.macroEvents === request.macroEvents && ahead.request.splitFactor === request.splitFactor && ahead.request.elevatedVolatility === request.elevatedVolatility) return ahead.prepared;
    return (await this.send(this.workerOf(request.symbol), { type: "prepareDay", ...request })) as PreparedDay;
  }

  /**
   * Builds a symbol's next day on its worker ahead of time, queued behind what was sent already; prepareDay() hands
   * it over when asked for the same day with the same request. Its failure, if any, is handed over the same way.
   */
  prepareDayAhead(request: PrepareDayRequest): void {
    if (this.failure) return;
    const prepared = this.send(this.workerOf(request.symbol), { type: "prepareDay", ...request }) as Promise<PreparedDay>;
    prepared.catch(() => {});
    this.preparedAheadByKey.set(`${request.symbol}|${request.market.todayIso}`, { request, prepared });
  }

  /** scoreTicker on the symbol's worker, over its inputs of the day with the book's figures of this pass. */
  async score(request: Omit<Extract<BacktestScoringWorkerRequest, { type: "score" }>, "type" | "modelTablesId" | "modelTables"> & { modelTables: VolatilityModelTables }): Promise<TickerSignals> {
    const poolWorker = this.workerOf(request.symbol);
    let modelTablesId = this.modelTablesIds.get(request.modelTables);
    if (modelTablesId === undefined) {
      modelTablesId = this.nextRequestId++;
      this.modelTablesIds.set(request.modelTables, modelTablesId);
    }
    const firstTime = !poolWorker.modelTablesIds.has(modelTablesId);
    poolWorker.modelTablesIds.add(modelTablesId);
    const sent: Extract<BacktestScoringWorkerRequest, { type: "score" }> = { ...request, type: "score", modelTablesId, modelTables: firstTime ? request.modelTables : null };
    this.lastScoreRequestBySymbol.set(request.symbol, sent);
    const dayQuotesOfLastWarm = this.lastWarmDayQuotesBySymbol.get(request.symbol) === request.dayQuotes;
    return (await this.send(poolWorker, dayQuotesOfLastWarm ? { ...sent, dayQuotes: [], dayQuotesOfLastWarm } : sent)) as TickerSignals;
  }

  /**
   * Scores the symbol's next look ahead of time, on its last request's book, and drops the result: the worker keeps the
   * implied volatilities and valuations it works out (exact-input caches, impliedVolatilitySurface.ts and
   * contractValuation.ts), so the look's own scoring, once the book is known, finds most of them done. Queued behind
   * the requests already sent; nothing when the symbol was not scored today yet.
   */
  warm(symbol: string, nextLook: { todayIso: string; dayQuotes: LiveOptionQuote[]; spotPrice: number; scoredAtMs: number }): void {
    const last = this.lastScoreRequestBySymbol.get(symbol);
    if (!last || last.todayIso !== nextLook.todayIso || this.failure) return;
    this.lastWarmDayQuotesBySymbol.set(symbol, nextLook.dayQuotes);
    void this.send(this.workerOf(symbol), { ...last, type: "warm", dayQuotesOfLastWarm: false, modelTables: null, dayQuotes: nextLook.dayQuotes, live: { ...last.live, spotPrice: nextLook.spotPrice }, scoredAtMs: nextLook.scoredAtMs }).catch(() => {});
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((poolWorker) => poolWorker.worker.terminate()));
  }
}
