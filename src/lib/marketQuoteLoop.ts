import type { IBApi } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { runRollingQuoteWindow, type RollingQuoteWindowOptions, type RollingQuoteWindowResult, type WindowContract, type WindowQuote } from "../ibkr/rollingQuoteWindow.js";
import { releaseMarketDataLines, reserveMarketDataLines, type LineReservationResult } from "../ibkr/marketDataLineBudget.js";
import { sharedLiveConnection } from "../ibkr/sharedReadConnection.js";
import { readAppEnvironment } from "./appEnvironment.js";
import { reportBackgroundFailure, reportBackgroundRecovery } from "./backgroundFailureAlert.js";
import { easternIsoDate } from "./easternIsoDate.js";
import { computeMarketSessionStatus, couldRegularSessionBeOpenByClock } from "./marketSessionStatus.js";
import { formatIsoDateAsExpiry } from "./expiryFormat.js";
import { readGitSha } from "./readGitSha.js";
import { sleepUnlessAborted } from "./sleepUnlessAborted.js";

// The market quote loop (Marcelo 2026-10-27, replacing the Day Signals loop). A background service in the web dyno,
// gated by MARKET_QUOTE_LOOP_ENABLED, that quotes only what something is using right now. Each user ("consumer") says
// which tickers and contracts it needs this cycle; the loop quotes their union once and hands every quote back:
//
//   - Pluto's CC + Put Ladder: its band, only while the ladder is the active strategy and Pluto is not paused;
//   - the assignment-risk alert: every held short leg, all session;
//   - the Volatility screen and Pulse's Top premiums: each ticker's stock (with IBKR's 30-day IV) and a few Calls per
//     expiry, only while one of them is open.
//
// With nothing to quote it holds no lines. Running, it holds `marketQuoteLoopLines` priority lines (live screens shed
// to it, never the reverse) and runs cycles back to back on sharedLiveConnection: a stock pass over every needed
// ticker, then one rolling window over every needed option contract, consumers in priority order (the ladder first).
// Throughput is bound by the connection's message rate (about 10 contracts a second), not by the line count.

export const marketQuoteLoopLineHolder = "marketQuoteLoop";
export const marketQuoteLoopLines = 10;
const lineReservationTtlSeconds = 90;
const lineReservationRenewIntervalMs = 60_000;
const stateCheckIntervalMs = 30_000;
/** A cycle that quoted only stocks (or finished fast) waits this long before the next, so an idle-ish loop does not spin. */
const minimumCycleMs = 5_000;
const afterDisconnectBackoffMs = 5_000;
const heartbeatIntervalMs = 60_000;
export const marketQuoteContractTimeoutMs = 4_000;

export interface QuoteLoopTicker {
  tickerId: string;
  symbol: string;
}

export interface QuoteLoopContract {
  tickerId: string;
  symbol: string;
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
}

export interface QuoteLoopCycle {
  tradingDateIso: string;
  cycleNumber: number;
  now: Date;
  /** Last price (or mid) per ticker from this cycle's stock pass. */
  spotByTicker: ReadonlyMap<string, number | null>;
  /** IBKR's 30-day implied volatility per ticker from this cycle's stock pass, for tickers whose consumer asked for it. */
  impliedVolatilityByTicker: ReadonlyMap<string, number | null>;
}

export interface QuoteLoopOptionQuote {
  contract: QuoteLoopContract;
  bid: number | null;
  ask: number | null;
  last: number | null;
  errorCode: number | null;
  quotedAt: Date;
}

/** One user of the loop. Every method may throw: the loop reports it and carries on without that consumer this cycle. */
export interface MarketQuoteConsumer {
  name: string;
  /** Ask the stock pass for IBKR's 30-day implied volatility on this consumer's tickers. */
  wantsImpliedVolatility?: boolean;
  /** The tickers this consumer needs this cycle; none = it is idle. */
  tickers(tradingDateIso: string, now: Date): Promise<QuoteLoopTicker[]>;
  /** Called once the stock pass has settled. */
  onStockPass?(cycle: QuoteLoopCycle): void;
  /** The option contracts to quote this cycle, given the stock pass. */
  contracts(cycle: QuoteLoopCycle): Promise<QuoteLoopContract[]>;
  /** Each settled quote of a contract this consumer asked for, as it settles. */
  onQuote?(quote: QuoteLoopOptionQuote, cycle: QuoteLoopCycle): void;
  /** After every quote of the cycle settled (not called on a disconnect or abort). */
  onCycleComplete?(quotes: QuoteLoopOptionQuote[], cycle: QuoteLoopCycle): Promise<void>;
}

export type MarketQuoteLoopState = "disabled" | "idle" | "running";

export interface MarketQuoteLoopStatus {
  state: MarketQuoteLoopState;
  reason: string;
  stateSince: string;
  tradingDateIso: string | null;
  cycleNumber: number;
  lastCycleDurationMs: number | null;
  lastCycleTickers: number;
  lastCycleContracts: number;
  /** Contracts per consumer in the last cycle (a contract two consumers want counts for both). */
  lastCycleContractsByConsumer: Record<string, number>;
  lastError: string | null;
}

export interface MarketQuoteLoopDependencies {
  now(): Date;
  isMarketOpen(now: Date): Promise<boolean>;
  reserveLines(holder: string, lines: number, ttlSeconds: number): Promise<LineReservationResult>;
  releaseLines(holder: string): Promise<void>;
  borrowLiveConnection(): Promise<{ ib: IBApi }>;
  allocateReqId(): number;
  runQuoteWindow(contracts: WindowContract[], options: RollingQuoteWindowOptions): Promise<RollingQuoteWindowResult>;
  writeHeartbeat(status: MarketQuoteLoopStatus): Promise<void>;
  reportFailure?(source: string, message: string): void;
  reportRecovery?(source: string, message: string): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const defaultMarketQuoteLoopDependencies: MarketQuoteLoopDependencies = {
  now: () => new Date(),
  isMarketOpen: async (now) => (await computeMarketSessionStatus(now)).state === "open",
  reserveLines: (holder, lines, ttlSeconds) => reserveMarketDataLines(holder, lines, ttlSeconds, { priority: true }),
  releaseLines: releaseMarketDataLines,
  borrowLiveConnection: () => sharedLiveConnection.borrow(),
  allocateReqId: () => sharedLiveConnection.allocateReqId(),
  runQuoteWindow: runRollingQuoteWindow,
  writeHeartbeat: async (status) => {
    await db("worker_health")
      .insert({
        process_name: "market_quote_loop",
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
  reportFailure: reportBackgroundFailure,
  reportRecovery: reportBackgroundRecovery,
  sleep: sleepUnlessAborted,
};

export function contractKeyOf(contract: Pick<QuoteLoopContract, "tickerId" | "expiry" | "strike" | "right">): string {
  return `${contract.tickerId}|${contract.expiry}|${contract.strike}|${contract.right}`;
}

function spotFromQuote(quote: WindowQuote): number | null {
  return quote.last ?? (quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : null);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MarketQuoteLoop {
  private status: MarketQuoteLoopStatus;
  private abort: AbortController | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private linesHeld = false;

  constructor(
    private readonly consumers: MarketQuoteConsumer[],
    private readonly deps: MarketQuoteLoopDependencies = defaultMarketQuoteLoopDependencies,
  ) {
    this.status = { state: "disabled", reason: "not started", stateSince: deps.now().toISOString(), tradingDateIso: null, cycleNumber: 0, lastCycleDurationMs: null, lastCycleTickers: 0, lastCycleContracts: 0, lastCycleContractsByConsumer: {}, lastError: null };
  }

  getStatus(): MarketQuoteLoopStatus {
    return { ...this.status, lastCycleContractsByConsumer: { ...this.status.lastCycleContractsByConsumer } };
  }

  /** Runs until stop(); resolves when the loop has exited. */
  start(): Promise<void> {
    if (this.abort) throw new Error("MarketQuoteLoop already started");
    this.abort = new AbortController();
    this.setState("idle", "starting");
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    return this.run(this.abort.signal);
  }

  stop(): void {
    this.abort?.abort();
  }

  private setState(state: MarketQuoteLoopState, reason: string): void {
    if (this.status.state === state && this.status.reason === reason) return;
    this.status = { ...this.status, state, reason, stateSince: this.deps.now().toISOString() };
    console.log(`market quote loop: ${state} — ${reason}`);
    void this.heartbeat();
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.deps.writeHeartbeat(this.getStatus());
    } catch (error) {
      console.warn(`market quote loop: heartbeat failed — ${errorText(error)}`);
      if (!couldRegularSessionBeOpenByClock(this.deps.now())) return;
      this.deps.reportFailure?.("market-quote-loop:heartbeat", `Market quote loop could not write its heartbeat (${errorText(error)}). The health check will report the loop as down.`);
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        let ranCycle = false;
        try {
          ranCycle = await this.tick(signal);
        } catch (error) {
          this.status.lastError = errorText(error);
          console.error(`market quote loop: ${this.status.lastError}`);
          this.deps.reportFailure?.("market-quote-loop:cycle", `Market quote loop failed: ${this.status.lastError}. It retries every 30 s; live quotes are stale until it recovers.`);
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

  /** One state evaluation; true when a cycle ran (the next evaluation follows after at most minimumCycleMs). */
  private async tick(signal: AbortSignal): Promise<boolean> {
    const now = this.deps.now();
    const tradingDateIso = easternIsoDate(now);
    if (!couldRegularSessionBeOpenByClock(now) || !(await this.deps.isMarketOpen(now))) {
      await this.releaseLines();
      this.setState("idle", "market closed");
      return false;
    }
    const tickersByConsumer = new Map<MarketQuoteConsumer, QuoteLoopTicker[]>();
    for (const consumer of this.consumers) {
      const tickers = await this.safely(consumer, "tickers", () => consumer.tickers(tradingDateIso, now), []);
      if (tickers.length > 0) tickersByConsumer.set(consumer, tickers);
    }
    if (tickersByConsumer.size === 0) {
      await this.releaseLines();
      this.setState("idle", "nothing to quote");
      return false;
    }
    if (!(await this.ensureLines())) return false;
    let borrowed: { ib: IBApi };
    try {
      borrowed = await this.deps.borrowLiveConnection();
    } catch (error) {
      this.setState("idle", `IBKR live connection not ready (${errorText(error)})`);
      return false;
    }
    this.status.tradingDateIso = tradingDateIso;
    this.setState("running", `quoting for ${[...tickersByConsumer.keys()].map((consumer) => consumer.name).join(", ")}`);
    const startedAt = this.deps.now().getTime();
    const result = await this.runCycle(borrowed.ib, tradingDateIso, tickersByConsumer, signal);
    this.status.lastCycleDurationMs = this.deps.now().getTime() - startedAt;
    if (result.disconnected) {
      this.status.lastError = "IBKR live connection dropped mid-cycle";
      this.deps.reportFailure?.("market-quote-loop:cycle", "Market quote loop: the IBKR live connection dropped mid-cycle. It retries after a short pause.");
      await this.deps.sleep(afterDisconnectBackoffMs, signal);
    } else if (!signal.aborted) {
      this.deps.reportRecovery?.("market-quote-loop:cycle", "Market quote loop cycles are completing again");
      const remainingMs = minimumCycleMs - this.status.lastCycleDurationMs;
      if (remainingMs > 0) await this.deps.sleep(remainingMs, signal);
    }
    return true;
  }

  private async runCycle(ib: IBApi, tradingDateIso: string, tickersByConsumer: Map<MarketQuoteConsumer, QuoteLoopTicker[]>, signal: AbortSignal): Promise<RollingQuoteWindowResult> {
    const cycleNumber = ++this.status.cycleNumber;
    const spotByTicker = new Map<string, number | null>();
    const impliedVolatilityByTicker = new Map<string, number | null>();

    // Stock pass: one entry per ticker, asking for the IV when any consumer of that ticker wants it.
    const stocks = new Map<string, WindowContract>();
    for (const [consumer, tickers] of tickersByConsumer) {
      for (const ticker of tickers) {
        const existing = stocks.get(ticker.tickerId);
        const withImpliedVolatility = (existing?.withImpliedVolatility ?? false) || consumer.wantsImpliedVolatility === true;
        stocks.set(ticker.tickerId, { key: `${ticker.tickerId}|stock`, legType: "stock", symbol: ticker.symbol, withImpliedVolatility });
      }
    }
    const stockPass = await this.deps.runQuoteWindow([...stocks.values()], {
      ib,
      allocateReqId: this.deps.allocateReqId,
      concurrency: marketQuoteLoopLines,
      timeoutMs: marketQuoteContractTimeoutMs,
      signal,
      onSettled: (contract, quote) => {
        const tickerId = contract.key.split("|")[0]!;
        spotByTicker.set(tickerId, spotFromQuote(quote));
        if (contract.withImpliedVolatility) impliedVolatilityByTicker.set(tickerId, quote.impliedVolatility);
      },
      now: this.deps.now,
    });
    if (stockPass.disconnected || stockPass.aborted) return stockPass;
    const cycle: QuoteLoopCycle = { tradingDateIso, cycleNumber, now: this.deps.now(), spotByTicker, impliedVolatilityByTicker };

    // Contracts, consumers in priority order; a contract two consumers want is quoted once.
    const consumersByKey = new Map<string, MarketQuoteConsumer[]>();
    const windowContracts: WindowContract[] = [];
    const contractsByKey = new Map<string, QuoteLoopContract>();
    const contractsByConsumer: Record<string, number> = {};
    for (const consumer of tickersByConsumer.keys()) {
      if (consumer.onStockPass) await this.safely(consumer, "onStockPass", async () => consumer.onStockPass!(cycle), undefined);
      const contracts = await this.safely(consumer, "contracts", () => consumer.contracts(cycle), []);
      contractsByConsumer[consumer.name] = contracts.length;
      for (const contract of contracts) {
        const key = contractKeyOf(contract);
        const wanting = consumersByKey.get(key);
        if (wanting) {
          if (!wanting.includes(consumer)) wanting.push(consumer);
          continue;
        }
        consumersByKey.set(key, [consumer]);
        contractsByKey.set(key, contract);
        windowContracts.push({ key, legType: "option", symbol: contract.symbol, expiry: formatIsoDateAsExpiry(contract.expiry), strike: contract.strike, right: contract.right });
      }
    }

    const quotesByConsumer = new Map<MarketQuoteConsumer, QuoteLoopOptionQuote[]>([...tickersByConsumer.keys()].map((consumer) => [consumer, []]));
    const result = await this.deps.runQuoteWindow(windowContracts, {
      ib,
      allocateReqId: this.deps.allocateReqId,
      concurrency: marketQuoteLoopLines,
      timeoutMs: marketQuoteContractTimeoutMs,
      signal,
      onSettled: (windowContract, windowQuote) => {
        const contract = contractsByKey.get(windowContract.key);
        if (!contract) return;
        const quote: QuoteLoopOptionQuote = { contract, bid: windowQuote.bid, ask: windowQuote.ask, last: windowQuote.last, errorCode: windowQuote.errorCode, quotedAt: windowQuote.settledAt };
        for (const consumer of consumersByKey.get(windowContract.key) ?? []) {
          quotesByConsumer.get(consumer)!.push(quote);
          if (!consumer.onQuote) continue;
          try {
            consumer.onQuote(quote, cycle);
          } catch (error) {
            this.reportConsumerFailure(consumer, "onQuote", error);
          }
        }
      },
      now: this.deps.now,
    });
    this.status.lastCycleTickers = stocks.size;
    this.status.lastCycleContracts = windowContracts.length;
    this.status.lastCycleContractsByConsumer = contractsByConsumer;
    if (result.disconnected || result.aborted) return result;
    for (const [consumer, quotes] of quotesByConsumer) {
      if (consumer.onCycleComplete) await this.safely(consumer, "onCycleComplete", () => consumer.onCycleComplete!(quotes, cycle), undefined);
    }
    return result;
  }

  private async safely<T>(consumer: MarketQuoteConsumer, step: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.reportConsumerFailure(consumer, step, error);
      return fallback;
    }
  }

  private reportConsumerFailure(consumer: MarketQuoteConsumer, step: string, error: unknown): void {
    console.warn(`market quote loop: ${consumer.name} ${step} failed — ${errorText(error)}`);
    this.deps.reportFailure?.(`market-quote-loop:${consumer.name}:${step}`, `Market quote loop: ${consumer.name} could not run its ${step} step (${errorText(error)}), so it gets no live quotes until it can.`);
  }

  private async ensureLines(): Promise<boolean> {
    const reservation = await this.deps.reserveLines(marketQuoteLoopLineHolder, marketQuoteLoopLines, lineReservationTtlSeconds);
    if (!reservation.ok) {
      this.linesHeld = false;
      this.setState(
        "idle",
        reservation.disabled
          ? "IBKR market-data lines disabled in this environment (IBKR_MARKET_DATA_LINES_ENABLED=false)"
          : `IBKR market-data lines unavailable (${reservation.availableLines} free)`,
      );
      return false;
    }
    this.linesHeld = true;
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => {
        this.deps.reserveLines(marketQuoteLoopLineHolder, marketQuoteLoopLines, lineReservationTtlSeconds).catch((error) => {
          console.warn(`market quote loop: could not renew lines — ${errorText(error)}`);
          this.deps.reportFailure?.("market-quote-loop:line-renew", `Market quote loop could not renew its IBKR market-data lines (${errorText(error)}). Live screens may take them mid-session.`);
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
    await this.deps.releaseLines(marketQuoteLoopLineHolder).catch((error) => console.warn(`market quote loop: could not release lines — ${errorText(error)}`));
  }
}

let runningLoop: MarketQuoteLoop | null = null;

/** Started once by server.ts when MARKET_QUOTE_LOOP_ENABLED=true; the health route reads its status. */
export function startMarketQuoteLoop(consumers: MarketQuoteConsumer[]): MarketQuoteLoop {
  if (runningLoop) return runningLoop;
  runningLoop = new MarketQuoteLoop(consumers);
  runningLoop.start().catch((error) => {
    console.error(`market quote loop exited: ${errorText(error)}`);
    reportBackgroundFailure("market-quote-loop:exited", `🔥 Market quote loop exited and will not restart until the web dyno does: ${errorText(error)}`);
  });
  return runningLoop;
}

export function marketQuoteLoopStatus(): MarketQuoteLoopStatus | null {
  return runningLoop?.getStatus() ?? null;
}
