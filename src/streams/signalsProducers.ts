import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { streamPooledPrices } from "../ibkr/pricePool.js";
import { streamSignalsOptionQuotes } from "../ibkr/streamSignalsOptionQuotes.js";
import { onDayQuotesUpdated } from "../lib/daySignalsEvents.js";
import { daySignalsLoopStatus, type DaySignalsLoopStatus } from "../lib/daySignalsLoop.js";
import { loadDayQuotesStatus, type DayQuotesStatus } from "../lib/daySignalsStore.js";
import { fetchAvailableUncoveredShares } from "../lib/positionQueries.js";
import { uncompensatedShareRefreshIntervalMs, type SignalCandidate, type SignalSurfaceSlice } from "../lib/signalCandidates.js";
import { accountRefreshIntervalMs, candidateContractKey, candidateContractRef, contractKey, liveFrameIntervalMs, scoreTicker, selectLiveQuoteContracts, shouldRefreshUncompensatedShare, toScreenRow, type ContractRef, type LiveOptionQuote } from "../lib/signalsLiveScoring.js";
import { loadAccountContext, loadDayQuotesAsLiveQuotes, loadSignalsUniverseTicker, loadSignalsUniverseTickers, loadTickerSignalsInputs, type SignalsTickerRow } from "../lib/signalsStore.js";
import { loadSignalSettings, type SignalSettings } from "../lib/signalSettingsStore.js";
import type { AccountContext, SignalsPriceSource, SignalsScreenRow, TickerSignals, TickerSignalsInputs } from "../lib/signalsTypes.js";
import { computeUncompensatedSharesInWorker } from "../lib/uncompensatedShareWorkerPool.js";
import type { StreamProducer } from "./streamProducers.js";
import { StreamRequestError } from "./streamProtocol.js";

// Signals live layer (stage 2, decisions with Marcelo 2026-09-22; Day Signals
// 2026-09-24). Two snapshot streams: `signalsScreen` (every shortlist ticker,
// one stock line each plus — unless `bestContractLines` is "false" — one
// pooled option line on each ticker's best contract, rows only) and
// `signalsTicker` (one ticker: stock line + live quotes for the selected
// expiry's contracts + the UncompensatedShare Monte Carlo in a worker
// thread). Both merge the Day Signals loop's quotes for everything else and
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
  /** Contract keys (expiry|strike|right) with a live IBKR quote subscription for this stream's life. */
  liveQuoteContracts: string[];
  uncompensatedAsOf: { spotPrice: number; at: string } | null;
}

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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Coalesces dirty marks into at most one flush per interval; the first mark after a quiet spell flushes at once. */
function createThrottledFlush(intervalMs: number, flush: () => void, signal: AbortSignal, lastFlushAt: number): { markDirty(): void } {
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    timer = null;
    lastFlushAt = Date.now();
    flush();
  };
  signal.addEventListener(
    "abort",
    () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    { once: true },
  );
  return {
    markDirty() {
      if (signal.aborted || timer) return;
      const elapsed = Date.now() - lastFlushAt;
      if (elapsed >= intervalMs) run();
      else timer = setTimeout(run, intervalMs - elapsed);
    },
  };
}

/** Runs `refresh` on an interval, never overlapping itself, until the signal aborts. */
function startPeriodicRefresh(intervalMs: number, refresh: () => Promise<void>, signal: AbortSignal, label: string): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || signal.aborted) return;
    inFlight = true;
    refresh()
      .catch((error) => console.error(`${label} refresh failed:`, error))
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

/** A child signal that aborts with its parent or on its own. */
function childAbort(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

export function createSignalsProducers(deps: SignalsProducerDependencies = defaultSignalsProducerDependencies): { signalsScreen: StreamProducer; signalsTicker: StreamProducer } {
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
        liveQuotes: LiveOptionQuote[];
        /** The pooled line on this ticker's current best contract, if any. */
        bestLine: { key: string; abort: AbortController } | null;
        scored: TickerSignals;
      }
      const states = new Map<string, TickerState>();
      const statesByTickerId = new Map<string, TickerState>();
      tickers.forEach((ticker, index) => {
        const inputs = inputsList[index]!;
        const state: TickerState = { ticker, inputs, spot: null, priceSource: "snapshot", liveQuotes: [], bestLine: null, scored: scoreTicker(inputs, account, settings) };
        states.set(ticker.symbol, state);
        statesByTickerId.set(ticker.tickerId, state);
      });
      const rescore = (state: TickerState) => {
        const overrides = liveOverrides(state.inputs, state.spot, state.priceSource);
        state.scored = scoreTicker(state.inputs, account, settings, overrides ? { ...overrides, liveQuotes: state.liveQuotes } : undefined);
      };
      const emitFrame = () => {
        const frame: SignalsScreenFrame = { type: "signalsScreen", at: deps.now().toISOString(), rows: [...states.values()].map((state) => toScreenRow(state.scored)), dayQuotes: { loop: deps.daySignalsLoopStatus(), status: dayQuotesStatus } };
        emit(frame);
      };
      const frames = createThrottledFlush(liveFrameIntervalMs, emitFrame, signal, Date.now());

      // One pooled option line per ticker on its best contract (approved 2026-09-24), moved whenever "best" changes.
      const syncBestLine = (state: TickerState) => {
        if (!bestContractLines || signal.aborted) return;
        const best = state.scored.best;
        const key = best ? candidateContractKey(best) : null;
        if ((state.bestLine?.key ?? null) === key) return;
        state.bestLine?.abort.abort();
        state.bestLine = null;
        state.liveQuotes = [];
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
              state.liveQuotes = quotes;
              rescore(state);
              syncBestLine(state);
              frames.markDirty();
            },
            abort.signal,
          )
          .catch((error) => console.error(`signalsScreen ${state.ticker.symbol}: best-contract live quote failed`, error));
      };
      for (const state of states.values()) syncBestLine(state);
      emitFrame();

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
            rescore(state);
            syncBestLine(state);
            await refreshDayQuotesStatus();
          })
          .catch((error) => console.error(`signalsScreen ${state.ticker.symbol}: day quotes reload failed`, error));
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
            if (changed) frames.markDirty();
          },
          signal,
        );
      } catch (error) {
        console.error("signalsScreen: live prices failed, rows stay at snapshot prices", error);
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
      let liveQuotes: LiveOptionQuote[] = [];
      let uncompensatedByContract = new Map<string, number | null>();
      let uncompensatedAsOf: SignalsTickerFrame["uncompensatedAsOf"] = null;
      let lastSimulatedSpot: number | null = null;

      let scored = scoreTicker(inputs, account, settings, liveOverrides(inputs, spot, priceSource));
      const rescore = () => {
        const overrides = liveOverrides(inputs, spot, priceSource);
        scored = scoreTicker(inputs, account, settings, overrides ? { ...overrides, liveQuotes, uncompensatedByContract } : undefined);
      };

      const selectedExpiry = parameters.expiry ?? scored.best?.expiry ?? null;
      // One live line per open short leg (Roll Signals) ahead of the selected expiry's contracts.
      const liveQuoteContracts = selectLiveQuoteContracts(scored.candidates, selectedExpiry, inputs.openShortLegs);
      const liveQuoteContractKeys = liveQuoteContracts.map(contractKey);

      const emitFrame = () => {
        const frame: SignalsTickerFrame = { type: "signalsTicker", at: deps.now().toISOString(), signals: scored, liveQuoteContracts: liveQuoteContractKeys, uncompensatedAsOf };
        emit(frame);
      };
      emitFrame();
      const frames = createThrottledFlush(liveFrameIntervalMs, emitFrame, signal, Date.now());

      // Monte Carlo: now, then every 5 s but only after a >= 0.5% spot move (never overlapping).
      let simulationInFlight = false;
      const refreshUncompensatedShare = async () => {
        if (simulationInFlight || signal.aborted || scored.candidates.length === 0) return;
        const spotForSimulation = spot ?? inputs.header?.underlyingPrice ?? null;
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
          console.error(`signalsTicker ${symbol}: UncompensatedShare simulation failed`, error);
        } finally {
          simulationInFlight = false;
        }
      };
      void refreshUncompensatedShare();
      const simulationTimer = setInterval(() => void refreshUncompensatedShare(), uncompensatedShareRefreshIntervalMs);
      signal.addEventListener("abort", () => clearInterval(simulationTimer), { once: true });

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
          .catch((error) => console.error(`signalsTicker ${symbol}: day quotes reload failed`, error));
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
            frames.markDirty();
          },
          signal,
        )
        .catch((error) => console.error(`signalsTicker ${symbol}: live price failed, staying at the snapshot price`, error));

      const quotesTask =
        liveQuoteContracts.length === 0
          ? Promise.resolve()
          : deps
              .streamOptionQuotes(
                symbol,
                liveQuoteContracts,
                (quotes) => {
                  liveQuotes = quotes;
                  rescore();
                  frames.markDirty();
                },
                signal,
              )
              .catch((error) => console.error(`signalsTicker ${symbol}: live option quotes failed, staying at snapshot quotes`, error));

      await Promise.all([pricesTask, quotesTask]);
      await waitForAbort(signal);
    },
  };

  return { signalsScreen, signalsTicker };
}
