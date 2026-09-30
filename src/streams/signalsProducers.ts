import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { streamPooledPrices } from "../ibkr/pricePool.js";
import { streamSignalsOptionQuotes } from "../ibkr/streamSignalsOptionQuotes.js";
import { reportBackgroundFailure } from "../lib/backgroundFailureAlert.js";
import { onDayQuotesUpdated } from "../lib/daySignalsEvents.js";
import { daySignalsLoopStatus, type DaySignalsLoopStatus } from "../lib/daySignalsLoop.js";
import { loadDayQuotesStatus, type DayQuotesStatus } from "../lib/daySignalsStore.js";
import { fetchAvailableUncoveredShares } from "../lib/positionQueries.js";
import { uncompensatedShareRefreshIntervalMs, type SignalCandidate, type SignalSurfaceSlice } from "../lib/signalCandidates.js";
import { accountRefreshIntervalMs, candidateContractKey, candidateContractRef, contractKey, liveFrameIntervalMs, scoreTicker, shouldRefreshUncompensatedShare, toScreenRow, type ContractRef, type LiveOptionQuote } from "../lib/signalsLiveScoring.js";
import { createChainCellResolver, scoreSignalContract, scoreTickerWithExclusions, type SignalContractScore, type SignalsChainCell } from "../lib/signalsChain.js";
import { rollCandidateKey, type HeldLegScore, type RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import { loadCapturedDeltas } from "../lib/signalsChainStore.js";
import { loadAccountContext, loadDayQuotesAsLiveQuotes, loadSignalsUniverseTicker, loadSignalsUniverseTickers, loadTickerSignalsInputs, type SignalsTickerRow } from "../lib/signalsStore.js";
import { loadSignalSettings, type SignalSettings } from "../lib/signalSettingsStore.js";
import type { AccountContext, SignalsPriceSource, SignalsScreenRow, TickerSignals, TickerSignalsInputs } from "../lib/signalsTypes.js";
import { computeUncompensatedSharesInWorker } from "../lib/uncompensatedShareWorkerPool.js";
import type { StreamProducer } from "./streamProducers.js";
import { StreamRequestError } from "./streamProtocol.js";

/**
 * A failure inside a Signals stream (per viewer, so it can repeat every frame): still logged, and one
 * rate-limited Telegram alert per category per hour (backgroundFailureAlert.ts). Rows/quotes stay on
 * the snapshot values meanwhile, which is exactly what makes the failure invisible on screen.
 */
function reportStreamFailure(category: string, description: string, error: unknown): void {
  console.error(description, error);
  reportBackgroundFailure(`signals:${category}`, `Signals live data failing (${category}): ${description}: ${error instanceof Error ? error.message : error}. Rows and quotes stay on their snapshot values until it recovers; this alert repeats at most hourly.`);
}


// Signals live layer (stage 2, decisions with Marcelo 2026-09-22; Day Signals
// 2026-09-24). Two snapshot streams: `signalsScreen` (every shortlist ticker,
// one stock line each plus — unless `bestContractLines` is "false" — one
// pooled option line on each ticker's best contract, rows only) and
// `signalsTicker` (one ticker: stock line + the UncompensatedShare Monte Carlo in a worker
// thread; since 2026-09-29 it holds no option lines — `signalsQuotes` below holds them, only for the
// contracts the modal has on screen). Both merge the Day Signals loop's quotes for everything else and
// re-score when the loop announces a ticker's quotes changed. Frames carry
// full state and go out at most once a second; account context (free cash /
// shares) refreshes every 60 s. Dependencies are injectable so the
// orchestration is testable offline.

export interface SignalsScreenFrame {
  type: "signalsScreen";
  at: string;
  rows: SignalsScreenRow[];
  dayQuotes: { loop: DaySignalsLoopStatus | null; status: DayQuotesStatus };
}

export interface SignalsTickerFrame {
  type: "signalsTicker";
  at: string;
  signals: TickerSignals;
  uncompensatedAsOf: { spotPrice: number; at: string } | null;
}

/**
 * The `signalsQuotes` stream: live quotes for exactly the contracts the Signals modal has on screen (visible rows plus one row
 * each side; approved 2026-09-29), scored at the live spot. The modal reopens it when what is on screen changes, and overlays
 * these on the ticker stream's day/snapshot-priced state. Keys are expiry|strike|right; held legs are keyed by leg id.
 */
export interface SignalsQuotesFrame {
  type: "signalsQuotes";
  at: string;
  spotPrice: number | null;
  /** Requested contracts with a live line (their quote may not have arrived yet). */
  contractKeys: string[];
  /** Option-chain cell of each requested contract that has a quote. */
  cells: Record<string, SignalsChainCell>;
  /** Signals candidates among the requested contracts. */
  candidates: Record<string, SignalCandidate>;
  /** Held legs whose contract was requested, by leg id. */
  heldLegs: Record<string, HeldLegScore>;
  /** Rolls whose held leg and replacement were both requested, by rollCandidateKey. */
  rolls: Record<string, RollSignalCandidate>;
  /**
   * Each pinned contract (an order under review) scored live exactly like GET /signals/:symbol/contract: filters lifted, its
   * rolls against the held legs of the same right. A pinned held-leg contract only gets its line (see heldLegs).
   */
  pinned: Record<string, SignalContractScore>;
}

export const signalsQuotesMaxContracts = 60;
/** Contracts an order under review depends on (the pick and, for a roll, the held leg): their lines come on top of the on-screen ones. */
export const signalsQuotesMaxPinned = 4;
const contractKeyPattern = /^\d{4}-\d{2}-\d{2}\|\d+(\.\d+)?\|[CP]$/;

export const dayQuotesStatusRefreshIntervalMs = 30_000;

export interface SignalsProducerDependencies {
  loadSignalsUniverseTickers(): Promise<SignalsTickerRow[]>;
  loadSignalsUniverseTicker(symbol: string): Promise<SignalsTickerRow | null>;
  loadTickerSignalsInputs(ticker: SignalsTickerRow): Promise<TickerSignalsInputs>;
  loadDayQuotes(ticker: SignalsTickerRow, snapshotTradingDateIso: string): Promise<LiveOptionQuote[]>;
  onDayQuotesUpdated(listener: (tickerId: string) => void): () => void;
  loadDayQuotesStatus(): Promise<DayQuotesStatus>;
  daySignalsLoopStatus(): DaySignalsLoopStatus | null;
  loadAccountContext(): Promise<AccountContext>;
  loadSignalSettings(): Promise<SignalSettings>;
  fetchAvailableUncoveredShares(tickerId: string): Promise<number>;
  streamLivePrices(contracts: PriceContract[], onUpdate: (prices: Record<string, number | null>, status: { frozenPhaseComplete: boolean }) => void, signal: AbortSignal): Promise<void>;
  streamOptionQuotes(symbol: string, contracts: ContractRef[], onUpdate: (quotes: LiveOptionQuote[]) => void, signal: AbortSignal): Promise<void>;
  computeUncompensatedShares(candidates: SignalCandidate[], spotPrice: number, slices: SignalSurfaceSlice[]): Promise<Map<string, number | null>>;
  /** IBKR's own delta per contract key from the capture the inputs came from (the fallback for a pinned contract without a live delta). */
  loadCapturedDeltas(inputs: TickerSignalsInputs): Promise<Map<string, number>>;
  now(): Date;
}

export const defaultSignalsProducerDependencies: SignalsProducerDependencies = {
  loadSignalsUniverseTickers,
  loadSignalsUniverseTicker,
  loadTickerSignalsInputs,
  loadDayQuotes: (ticker, snapshotTradingDateIso) => loadDayQuotesAsLiveQuotes(ticker.tickerId, snapshotTradingDateIso),
  onDayQuotesUpdated,
  loadDayQuotesStatus,
  daySignalsLoopStatus,
  loadAccountContext,
  loadSignalSettings,
  fetchAvailableUncoveredShares,
  streamLivePrices: streamPooledPrices,
  streamOptionQuotes: streamSignalsOptionQuotes,
  computeUncompensatedShares: (candidates, spotPrice, slices) => computeUncompensatedSharesInWorker(candidates, spotPrice, slices),
  loadCapturedDeltas: async (inputs) => (inputs.header ? loadCapturedDeltas(inputs.header.snapshotId, null) : new Map<string, number>()),
  now: () => new Date(),
};

const symbolPattern = /^[A-Za-z0-9.\-]{1,15}$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function readParameterObject(rawParameters: unknown): Record<string, unknown> {
  if (rawParameters === undefined || rawParameters === null) return {};
  if (typeof rawParameters !== "object" || Array.isArray(rawParameters)) throw new StreamRequestError(400, "parameters must be an object.");
  return rawParameters as Record<string, unknown>;
}

/** `bestContractLines: false` (the modal is open and holds its own lines) is the only option; anything else is rejected. */
function parseScreenParameters(rawParameters: unknown): Record<string, string> {
  const parameters = readParameterObject(rawParameters);
  const unknownField = Object.keys(parameters).find((key) => key !== "bestContractLines");
  if (unknownField) throw new StreamRequestError(400, `Unknown parameter: ${unknownField}.`);
  const bestContractLines = parameters.bestContractLines;
  if (bestContractLines !== undefined && typeof bestContractLines !== "boolean") throw new StreamRequestError(400, "bestContractLines must be a boolean.");
  return bestContractLines === false ? { bestContractLines: "false" } : {};
}

function parseTickerParameters(rawParameters: unknown): Record<string, string> {
  const parameters = readParameterObject(rawParameters);
  const unknownField = Object.keys(parameters).find((key) => key !== "symbol" && key !== "expiry");
  if (unknownField) throw new StreamRequestError(400, `Unknown parameter: ${unknownField}.`);
  const symbol = parameters.symbol;
  if (typeof symbol !== "string" || !symbolPattern.test(symbol)) throw new StreamRequestError(400, "symbol is required.");
  const expiry = parameters.expiry;
  if (expiry !== undefined && (typeof expiry !== "string" || !isoDatePattern.test(expiry))) throw new StreamRequestError(400, "expiry must be a YYYY-MM-DD date.");
  return expiry === undefined ? { symbol: symbol.toUpperCase() } : { symbol: symbol.toUpperCase(), expiry };
}

/** `contracts`: comma-separated expiry|strike|right keys, at most signalsQuotesMaxContracts (an empty list is allowed: nothing on screen). `pinned`: the same keys, at most signalsQuotesMaxPinned, omitted when empty. */
function parseQuotesParameters(rawParameters: unknown): Record<string, string> {
  const parameters = readParameterObject(rawParameters);
  const unknownField = Object.keys(parameters).find((key) => key !== "symbol" && key !== "contracts" && key !== "pinned");
  if (unknownField) throw new StreamRequestError(400, `Unknown parameter: ${unknownField}.`);
  const symbol = parameters.symbol;
  if (typeof symbol !== "string" || !symbolPattern.test(symbol)) throw new StreamRequestError(400, "symbol is required.");
  const contracts = parameters.contracts;
  if (!Array.isArray(contracts) || contracts.some((key) => typeof key !== "string" || !contractKeyPattern.test(key))) throw new StreamRequestError(400, "contracts must be a list of expiry|strike|right keys.");
  if (contracts.length > signalsQuotesMaxContracts) throw new StreamRequestError(400, `At most ${signalsQuotesMaxContracts} contracts.`);
  const pinned = parameters.pinned ?? [];
  if (!Array.isArray(pinned) || pinned.some((key) => typeof key !== "string" || !contractKeyPattern.test(key))) throw new StreamRequestError(400, "pinned must be a list of expiry|strike|right keys.");
  if (pinned.length > signalsQuotesMaxPinned) throw new StreamRequestError(400, `At most ${signalsQuotesMaxPinned} pinned contracts.`);
  const pinnedKeys = [...new Set(pinned as string[])];
  return { symbol: symbol.toUpperCase(), contracts: [...new Set(contracts as string[])].join(","), ...(pinnedKeys.length > 0 ? { pinned: pinnedKeys.join(",") } : {}) };
}

function parseContractKey(key: string): ContractRef {
  const [expiry, strike, right] = key.split("|") as [string, string, "C" | "P"];
  return { expiry, strike: Number(strike), right };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** How long a stream waits for the live price before emitting its first frame anyway (at the snapshot spot). */
export const firstFramePriceGraceMs = 1_500;

/**
 * Coalesces dirty marks into at most one flush per interval; the first mark after a quiet spell flushes at once.
 * With `holdFirstFrameMs` nothing is flushed until `release()` (the live price arrived) or that grace elapses, so a
 * stream never opens with a frame scored at the stale snapshot spot that the price then corrects a second later.
 */
function createThrottledFlush(intervalMs: number, flush: () => void, signal: AbortSignal, lastFlushAt: number, holdFirstFrameMs?: number): { markDirty(): void; release(): boolean } {
  let timer: NodeJS.Timeout | null = null;
  let held = holdFirstFrameMs !== undefined;
  let holdTimer: NodeJS.Timeout | null = null;
  const run = () => {
    timer = null;
    lastFlushAt = Date.now();
    flush();
  };
  signal.addEventListener(
    "abort",
    () => {
      if (timer) clearTimeout(timer);
      if (holdTimer) clearTimeout(holdTimer);
      timer = null;
      holdTimer = null;
    },
    { once: true },
  );
  /** Ends the hold with the first frame; false when there was no hold to end (the caller then marks dirty as usual). */
  const release = () => {
    if (!held || signal.aborted) return false;
    held = false;
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    run();
    return true;
  };
  if (held) holdTimer = setTimeout(release, holdFirstFrameMs);
  return {
    markDirty() {
      if (signal.aborted || timer || held) return;
      const elapsed = Date.now() - lastFlushAt;
      if (elapsed >= intervalMs) run();
      else timer = setTimeout(run, intervalMs - elapsed);
    },
    release,
  };
}

/** Runs `refresh` on an interval, never overlapping itself, until the signal aborts. */
function startPeriodicRefresh(intervalMs: number, refresh: () => Promise<void>, signal: AbortSignal, label: string): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || signal.aborted) return;
    inFlight = true;
    refresh()
      .catch((error) => reportStreamFailure("refresh", `${label} refresh failed`, error))
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

function liveOverrides(inputs: TickerSignalsInputs, spot: number | null, priceSource: SignalsPriceSource) {
  const snapshotSpot = inputs.header?.underlyingPrice ?? null;
  if (spot === null && snapshotSpot === null) return undefined;
  return { spotPrice: spot ?? snapshotSpot!, priceSource: spot === null ? ("snapshot" as const) : priceSource };
}

/** A child signal that aborts with its parent or on its own. Aborting the child also unhooks it from the parent, so a long-lived parent never accumulates listeners from retired children. */
function childAbort(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort();
    return controller;
  }
  const abortWithParent = () => controller.abort();
  parent.addEventListener("abort", abortWithParent, { once: true });
  controller.signal.addEventListener("abort", () => parent.removeEventListener("abort", abortWithParent), { once: true });
  return controller;
}

export function createSignalsProducers(deps: SignalsProducerDependencies = defaultSignalsProducerDependencies): { signalsScreen: StreamProducer; signalsTicker: StreamProducer; signalsQuotes: StreamProducer } {
  const signalsScreen: StreamProducer = {
    isSnapshotStream: true,
    parseParameters: parseScreenParameters,
    async run(parameters, _context, emit, signal) {
      const bestContractLines = parameters.bestContractLines !== "false";
      const [tickers, initialAccount, settings, initialDayQuotesStatus] = await Promise.all([deps.loadSignalsUniverseTickers(), deps.loadAccountContext(), deps.loadSignalSettings(), deps.loadDayQuotesStatus()]);
      let account = initialAccount;
      let dayQuotesStatus = initialDayQuotesStatus;
      const inputsList = await Promise.all(tickers.map((ticker) => deps.loadTickerSignalsInputs(ticker)));
      if (signal.aborted) return;

      interface TickerState {
        ticker: SignalsTickerRow;
        inputs: TickerSignalsInputs;
        spot: number | null;
        priceSource: SignalsPriceSource;
        /**
         * Last live reading per contract key, kept when the best line moves on: a move is then judged live
         * against live and settles, rather than the new line's live quote against the old line's snapshot
         * quote, which flips straight back (and forth, without yielding to the event loop).
         */
        liveQuotes: Map<string, LiveOptionQuote>;
        /** The pooled line on this ticker's current best contract, if any. */
        bestLine: { key: string; abort: AbortController } | null;
        scored: TickerSignals;
      }
      const states = new Map<string, TickerState>();
      const statesByTickerId = new Map<string, TickerState>();
      tickers.forEach((ticker, index) => {
        const inputs = inputsList[index]!;
        const state: TickerState = { ticker, inputs, spot: null, priceSource: "snapshot", liveQuotes: new Map(), bestLine: null, scored: scoreTicker(inputs, account, settings) };
        states.set(ticker.symbol, state);
        statesByTickerId.set(ticker.tickerId, state);
      });
      const rescore = (state: TickerState) => {
        const overrides = liveOverrides(state.inputs, state.spot, state.priceSource);
        state.scored = scoreTicker(state.inputs, account, settings, overrides ? { ...overrides, liveQuotes: [...state.liveQuotes.values()] } : undefined);
      };
      const emitFrame = () => {
        const frame: SignalsScreenFrame = { type: "signalsScreen", at: deps.now().toISOString(), rows: [...states.values()].map((state) => toScreenRow(state.scored)), dayQuotes: { loop: deps.daySignalsLoopStatus(), status: dayQuotesStatus } };
        emit(frame);
      };
      // First frame waits until every ticker has its live price (see createThrottledFlush): scored at the stale snapshot spot the rows would flash wrong grades.
      const frames = createThrottledFlush(liveFrameIntervalMs, emitFrame, signal, Date.now(), firstFramePriceGraceMs);

      // One pooled option line per ticker on its best contract (approved 2026-09-24), moved whenever "best" changes.
      const syncBestLine = (state: TickerState) => {
        if (!bestContractLines || signal.aborted) return;
        const best = state.scored.best;
        const key = best ? candidateContractKey(best) : null;
        if ((state.bestLine?.key ?? null) === key) return;
        state.bestLine?.abort.abort();
        state.bestLine = null;
        if (!best) return;
        const abort = childAbort(signal);
        const line = { key: key!, abort };
        state.bestLine = line;
        deps
          .streamOptionQuotes(
            state.ticker.symbol,
            [candidateContractRef(best)],
            (quotes) => {
              if (state.bestLine !== line) return;
              for (const quote of quotes) state.liveQuotes.set(contractKey(quote), quote);
              rescore(state);
              syncBestLine(state);
              frames.markDirty();
            },
            abort.signal,
          )
          .catch((error) => reportStreamFailure("best-contract-quote", `signalsScreen ${state.ticker.symbol}: best-contract live quote failed`, error));
      };
      for (const state of states.values()) syncBestLine(state);

      const refreshDayQuotesStatus = async () => {
        const status = await deps.loadDayQuotesStatus();
        if (signal.aborted || JSON.stringify(status) === JSON.stringify(dayQuotesStatus)) return;
        dayQuotesStatus = status;
        frames.markDirty();
      };
      startPeriodicRefresh(dayQuotesStatusRefreshIntervalMs, refreshDayQuotesStatus, signal, "signalsScreen day quotes status");
      const unsubscribeDayQuotes = deps.onDayQuotesUpdated((tickerId) => {
        const state = statesByTickerId.get(tickerId);
        const header = state?.inputs.header;
        if (!state || !header || signal.aborted) return;
        deps
          .loadDayQuotes(state.ticker, header.tradingDateIso)
          .then(async (dayQuotes) => {
            if (signal.aborted) return;
            state.inputs = { ...state.inputs, dayQuotes };
            // Fresh day quotes outrank a live reading left behind by a line that has since moved on.
            for (const contract of state.liveQuotes.keys()) if (contract !== state.bestLine?.key) state.liveQuotes.delete(contract);
            rescore(state);
            syncBestLine(state);
            await refreshDayQuotesStatus();
          })
          .catch((error) => reportStreamFailure("day-quotes-reload", `signalsScreen ${state.ticker.symbol}: day quotes reload failed`, error));
      });
      signal.addEventListener("abort", unsubscribeDayQuotes, { once: true });

      startPeriodicRefresh(
        accountRefreshIntervalMs,
        async () => {
          const [refreshedAccount, freeSharesList] = await Promise.all([deps.loadAccountContext(), Promise.all(tickers.map((ticker) => deps.fetchAvailableUncoveredShares(ticker.tickerId)))]);
          if (signal.aborted) return;
          account = refreshedAccount;
          tickers.forEach((ticker, index) => {
            const state = states.get(ticker.symbol);
            if (state) state.inputs = { ...state.inputs, freeShares: freeSharesList[index]! };
          });
          for (const state of states.values()) {
            rescore(state);
            syncBestLine(state);
          }
          frames.markDirty();
        },
        signal,
        "signalsScreen account",
      );

      const priceContracts: PriceContract[] = tickers.map((ticker) => ({ key: ticker.symbol, legType: "stock", symbol: ticker.symbol }));
      try {
        await deps.streamLivePrices(
          priceContracts,
          (prices, status) => {
            let changed = false;
            for (const [symbol, price] of Object.entries(prices)) {
              const state = states.get(symbol);
              if (!state || price === null) continue;
              const priceSource: SignalsPriceSource = status.frozenPhaseComplete ? "live" : "frozen";
              if (state.spot === price && state.priceSource === priceSource) continue;
              state.spot = price;
              state.priceSource = priceSource;
              rescore(state);
              syncBestLine(state);
              changed = true;
            }
            const everyTickerPriced = [...states.values()].every((state) => state.spot !== null);
            if (everyTickerPriced && frames.release()) return;
            if (changed) frames.markDirty();
          },
          signal,
        );
      } catch (error) {
        reportStreamFailure("live-prices", "signalsScreen: live prices failed, rows stay at snapshot prices", error);
      }
      await waitForAbort(signal);
    },
  };

  const signalsTicker: StreamProducer = {
    isSnapshotStream: true,
    parseParameters: parseTickerParameters,
    async run(parameters, _context, emit, signal) {
      const symbol = parameters.symbol!;
      const ticker = await deps.loadSignalsUniverseTicker(symbol);
      if (!ticker) throw new StreamRequestError(404, `${symbol} is not on the shortlist and has no open short option leg.`);
      const [initialInputs, initialAccount, settings] = await Promise.all([deps.loadTickerSignalsInputs(ticker), deps.loadAccountContext(), deps.loadSignalSettings()]);
      if (signal.aborted) return;
      let inputs = initialInputs;
      let account = initialAccount;
      let spot: number | null = null;
      let priceSource: SignalsPriceSource = "snapshot";
      let uncompensatedByContract = new Map<string, number | null>();
      let uncompensatedAsOf: SignalsTickerFrame["uncompensatedAsOf"] = null;
      let lastSimulatedSpot: number | null = null;

      let scored = scoreTicker(inputs, account, settings, liveOverrides(inputs, spot, priceSource));
      const rescore = () => {
        const overrides = liveOverrides(inputs, spot, priceSource);
        scored = scoreTicker(inputs, account, settings, overrides ? { ...overrides, uncompensatedByContract } : undefined);
      };

      const emitFrame = () => {
        const frame: SignalsTickerFrame = { type: "signalsTicker", at: deps.now().toISOString(), signals: scored, uncompensatedAsOf };
        emit(frame);
      };
      // First frame waits for the live price (see createThrottledFlush): scored at the stale snapshot spot it would flash wrong grades.
      const frames = createThrottledFlush(liveFrameIntervalMs, emitFrame, signal, Date.now(), firstFramePriceGraceMs);

      // Monte Carlo: now, then every 5 s but only after a >= 0.5% spot move (never overlapping).
      let simulationInFlight = false;
      // Simulated at the live spot: at the snapshot spot it would give a wrong drift that the first price then corrects (after the grace with no price, the snapshot spot is all there is).
      let priceGraceElapsed = false;
      const refreshUncompensatedShare = async () => {
        if (simulationInFlight || signal.aborted || scored.candidates.length === 0) return;
        const spotForSimulation = spot ?? (priceGraceElapsed ? (inputs.header?.underlyingPrice ?? null) : null);
        if (spotForSimulation === null || !shouldRefreshUncompensatedShare(lastSimulatedSpot, spotForSimulation)) return;
        simulationInFlight = true;
        try {
          const results = await deps.computeUncompensatedShares(scored.candidates, spotForSimulation, inputs.slices);
          if (signal.aborted) return;
          uncompensatedByContract = results;
          lastSimulatedSpot = spotForSimulation;
          uncompensatedAsOf = { spotPrice: spotForSimulation, at: deps.now().toISOString() };
          rescore();
          frames.markDirty();
        } catch (error) {
          reportStreamFailure("uncompensated-share", `signalsTicker ${symbol}: UncompensatedShare simulation failed`, error);
        } finally {
          simulationInFlight = false;
        }
      };
      const priceGraceTimer = setTimeout(() => {
        priceGraceElapsed = true;
        void refreshUncompensatedShare();
      }, firstFramePriceGraceMs);
      const simulationTimer = setInterval(() => void refreshUncompensatedShare(), uncompensatedShareRefreshIntervalMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(priceGraceTimer);
          clearInterval(simulationTimer);
        },
        { once: true },
      );

      const unsubscribeDayQuotes = deps.onDayQuotesUpdated((tickerId) => {
        if (tickerId !== ticker.tickerId || !inputs.header || signal.aborted) return;
        deps
          .loadDayQuotes(ticker, inputs.header.tradingDateIso)
          .then((dayQuotes) => {
            if (signal.aborted) return;
            inputs = { ...inputs, dayQuotes };
            rescore();
            frames.markDirty();
          })
          .catch((error) => reportStreamFailure("day-quotes-reload", `signalsTicker ${symbol}: day quotes reload failed`, error));
      });
      signal.addEventListener("abort", unsubscribeDayQuotes, { once: true });

      startPeriodicRefresh(
        accountRefreshIntervalMs,
        async () => {
          const [refreshedAccount, freeShares] = await Promise.all([deps.loadAccountContext(), deps.fetchAvailableUncoveredShares(ticker.tickerId)]);
          if (signal.aborted) return;
          account = refreshedAccount;
          inputs = { ...inputs, freeShares };
          rescore();
          frames.markDirty();
        },
        signal,
        `signalsTicker ${symbol} account`,
      );

      const pricesTask = deps
        .streamLivePrices(
          [{ key: symbol, legType: "stock", symbol }],
          (prices, status) => {
            const price = prices[symbol];
            if (price === null || price === undefined) return;
            const source: SignalsPriceSource = status.frozenPhaseComplete ? "live" : "frozen";
            if (spot === price && priceSource === source) return;
            spot = price;
            priceSource = source;
            rescore();
            if (lastSimulatedSpot === null) void refreshUncompensatedShare();
            if (!frames.release()) frames.markDirty();
          },
          signal,
        )
        .catch((error) => reportStreamFailure("live-price", `signalsTicker ${symbol}: live price failed, staying at the snapshot price`, error));

      await pricesTask;
      await waitForAbort(signal);
    },
  };

  const signalsQuotes: StreamProducer = {
    isSnapshotStream: true,
    parseParameters: parseQuotesParameters,
    async run(parameters, _context, emit, signal) {
      const symbol = parameters.symbol!;
      const onScreenKeys = parameters.contracts ? parameters.contracts.split(",") : [];
      const pinnedKeys = parameters.pinned ? parameters.pinned.split(",") : [];
      // Every line this stream holds: what is on screen plus what the order under review depends on.
      const contractKeys = [...new Set([...onScreenKeys, ...pinnedKeys])];
      const ticker = await deps.loadSignalsUniverseTicker(symbol);
      if (!ticker) throw new StreamRequestError(404, `${symbol} is not on the shortlist and has no open short option leg.`);
      const [inputs, account, settings] = await Promise.all([deps.loadTickerSignalsInputs(ticker), deps.loadAccountContext(), deps.loadSignalSettings()]);
      const capturedDeltaByContract = await deps.loadCapturedDeltas(inputs);
      if (signal.aborted) return;
      const requested = new Set(contractKeys);
      let spot: number | null = null;
      let priceSource: SignalsPriceSource = "snapshot";
      let liveQuotes: LiveOptionQuote[] = [];
      // UncompensatedShare of the pinned candidates: the ticker stream's throttle (a worker run, only after a >= 0.5% spot move), never a per-frame simulation.
      let pinnedUncompensatedByContract = new Map<string, number | null>();
      let pinnedLastSimulatedSpot: number | null = null;
      let latestPinnedCandidates: SignalCandidate[] = [];

      const emitFrame = () => {
        const overrides = liveOverrides(inputs, spot, priceSource);
        const scoring = scoreTickerWithExclusions(inputs, account, settings, overrides ? { ...overrides, liveQuotes } : undefined);
        const liveDeltaByContract = new Map<string, number>();
        for (const quote of liveQuotes) if (quote.delta !== null && quote.delta !== undefined) liveDeltaByContract.set(contractKey(quote), quote.delta);
        const cellFor = createChainCellResolver(scoring, capturedDeltaByContract, liveDeltaByContract);
        const frame: SignalsQuotesFrame = { type: "signalsQuotes", at: deps.now().toISOString(), spotPrice: scoring.scored.spotPrice, contractKeys, cells: {}, candidates: {}, heldLegs: {}, rolls: {}, pinned: {} };
        for (const key of contractKeys) {
          const cell = cellFor(parseContractKey(key));
          if (cell.state !== "not_captured") frame.cells[key] = cell;
        }
        for (const candidate of scoring.scored.candidates) if (requested.has(candidateContractKey(candidate))) frame.candidates[candidateContractKey(candidate)] = candidate;
        const heldKeyByLegId = new Map(scoring.scored.heldLegs.map((leg) => [leg.legId, contractKey(leg)]));
        const heldKeys = new Set(heldKeyByLegId.values());
        for (const leg of scoring.scored.heldLegs) if (requested.has(contractKey(leg))) frame.heldLegs[leg.legId] = leg;
        for (const roll of scoring.scored.rolls) {
          if (requested.has(heldKeyByLegId.get(roll.legId) ?? "") && requested.has(candidateContractKey(roll.replacement))) frame.rolls[rollCandidateKey(roll)] = roll;
        }
        const liveSpot = spot === null ? null : { spotPrice: spot, priceSource };
        latestPinnedCandidates = [];
        for (const key of pinnedKeys) {
          if (heldKeys.has(key)) continue;
          const contract = parseContractKey(key);
          const liveQuote = liveQuotes.find((quote) => contractKey(quote) === key);
          const pinnedScore = scoreSignalContract({
            inputs,
            account,
            settings,
            contract,
            liveQuote: liveQuote && (liveQuote.bid !== null || liveQuote.ask !== null || (liveQuote.delta ?? null) !== null) ? { bid: liveQuote.bid, ask: liveQuote.ask, delta: liveQuote.delta ?? null, quotedAt: liveQuote.quotedAt ?? frame.at } : null,
            liveSpot,
            capturedDelta: capturedDeltaByContract.get(key) ?? null,
            uncompensatedByContract: pinnedUncompensatedByContract,
          });
          frame.pinned[key] = pinnedScore;
          if (pinnedScore.scored) latestPinnedCandidates.push(pinnedScore);
        }
        emit(frame);
        void refreshPinnedUncompensatedShare();
      };

      let pinnedSimulationInFlight = false;
      const refreshPinnedUncompensatedShare = async () => {
        const spotForSimulation = spot ?? inputs.header?.underlyingPrice ?? null;
        if (pinnedSimulationInFlight || signal.aborted || latestPinnedCandidates.length === 0 || spotForSimulation === null) return;
        const missingResult = latestPinnedCandidates.some((candidate) => !pinnedUncompensatedByContract.has(candidateContractKey(candidate)));
        if (!missingResult && !shouldRefreshUncompensatedShare(pinnedLastSimulatedSpot, spotForSimulation)) return;
        pinnedSimulationInFlight = true;
        try {
          const results = await deps.computeUncompensatedShares(latestPinnedCandidates, spotForSimulation, inputs.slices);
          if (signal.aborted) return;
          pinnedUncompensatedByContract = results;
          frames.markDirty();
        } catch (error) {
          reportStreamFailure("uncompensated-share", `signalsQuotes ${symbol}: UncompensatedShare simulation failed`, error);
          // No result for these candidates: record empty ones so the next frame does not retry in a loop.
          pinnedUncompensatedByContract = new Map(latestPinnedCandidates.map((candidate) => [candidateContractKey(candidate), null]));
        } finally {
          pinnedLastSimulatedSpot = spotForSimulation;
          pinnedSimulationInFlight = false;
        }
      };

      // First frame waits for the live price (see createThrottledFlush): scored at the stale snapshot spot it would flash wrong grades.
      const frames = createThrottledFlush(liveFrameIntervalMs, emitFrame, signal, Date.now(), firstFramePriceGraceMs);

      // The stock line is shared with the ticker stream's through the pool: no extra IBKR line.
      const pricesTask = deps
        .streamLivePrices(
          [{ key: symbol, legType: "stock", symbol }],
          (prices, status) => {
            const price = prices[symbol];
            if (price === null || price === undefined) return;
            const source: SignalsPriceSource = status.frozenPhaseComplete ? "live" : "frozen";
            if (spot === price && priceSource === source) return;
            spot = price;
            priceSource = source;
            if (!frames.release()) frames.markDirty();
          },
          signal,
        )
        .catch((error) => reportStreamFailure("live-price", `signalsQuotes ${symbol}: live price failed`, error));
      const quotesTask =
        contractKeys.length === 0
          ? Promise.resolve()
          : deps
              .streamOptionQuotes(
                symbol,
                contractKeys.map(parseContractKey),
                (quotes) => {
                  liveQuotes = quotes;
                  frames.markDirty();
                },
                signal,
              )
              .catch((error) => reportStreamFailure("live-option-quotes", `signalsQuotes ${symbol}: live option quotes failed`, error));
      await Promise.all([pricesTask, quotesTask]);
      await waitForAbort(signal);
    },
  };

  return { signalsScreen, signalsTicker, signalsQuotes };
}
