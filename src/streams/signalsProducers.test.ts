import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "../lib/impliedVolatilitySurface.js";
import type { SignalQuote, SignalSurfaceSlice } from "../lib/signalCandidates.js";
import { candidateContractKey, contractKey, liveFrameIntervalMs, type ContractRef, type LiveOptionQuote } from "../lib/signalsLiveScoring.js";
import type { SignalsTickerRow } from "../lib/signalsStore.js";
import type { TickerSignalsInputs } from "../lib/signalsTypes.js";
import { createSignalsProducers, firstFramePriceGraceMs, snapshotChangePollIntervalMs, type SignalsQuotesFrame, type SignalsProducerDependencies, type SignalsScreenFrame, type SignalsTickerFrame } from "./signalsProducers.js";
import { StreamRequestError } from "./streamProtocol.js";

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const years30 = 30 / 365;
const years60 = 60 / 365;
const slice = (expiry: string, years: number): SignalSurfaceSlice => ({
  expiry,
  status: "ok",
  parameters: params,
  kMin: -0.4,
  kMax: 0.4,
  yearsToExpiry: years,
  forwardPrice: forward,
  pointCount: 20,
  rmseVolatility: 0.01,
  minButterflyDensity: 0.8,
  droppedCounts: { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 },
  calendarChecks: 0,
  calendarViolations: 0,
});
function quoteAt(strike: number, right: "C" | "P", expiry: string, years: number): SignalQuote {
  const iv = Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years);
  const mid = blackScholesPriceOnForward(forward, strike, years, rate, iv, right === "C");
  return { expiry, strike, right, bid: mid * 0.98, ask: mid * 1.02, source: "snapshot" };
}
const aaoi: SignalsTickerRow = { tickerId: "id-aaoi", symbol: "AAOI", companyName: "Applied Opto", sector: "Tech" };
const hood: SignalsTickerRow = { tickerId: "id-hood", symbol: "HOOD", companyName: "Robinhood", sector: null };

function inputsFor(ticker: SignalsTickerRow, withSnapshot: boolean, freeShares = 200): TickerSignalsInputs {
  return {
    ...ticker,
    header: withSnapshot ? { snapshotId: "s1", tradingDateIso: "2026-09-21", capturedAt: "2026-09-21T14:00:00Z", underlyingPrice: forward, riskFreeRatePercent: rate * 100, fitCompletedAt: "2026-09-21T14:06:00Z", fitIssue: null } : null,
    slices: withSnapshot ? [slice("2026-10-21", years30), slice("2026-11-20", years60)] : [],
    quotes: withSnapshot ? [quoteAt(90, "P", "2026-10-21", years30), quoteAt(110, "C", "2026-10-21", years30), quoteAt(85, "P", "2026-11-20", years60), quoteAt(115, "C", "2026-11-20", years60)] : [],
    dayQuotes: [],
    forecast: withSnapshot ? { volatility: 0.15, windowDays: 63 } : null,
    suspectedSplitDateIso: null,
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    macroEvents: [],
    momentum: 0.1,
    elevatedVolatility: null,
    skew: null,
    nextEarningsDateIso: null,
    previousClose: { close: 98, dateIso: "2026-09-21" },
    freeShares,
    openShortLegs: [],
    dailyBarCount: 1253,
    dividendCadenceUnknown: false,
    todayEasternIso: "2026-09-22",
  };
}

interface OptionSubscription {
  symbol: string;
  contracts: ContractRef[];
  push(quotes: LiveOptionQuote[]): void;
  aborted(): boolean;
}

interface Harness {
  deps: SignalsProducerDependencies;
  priceUpdates: { push(prices: Record<string, number | null>, frozenPhaseComplete: boolean): void };
  quoteUpdates: { push(quotes: LiveOptionQuote[]): void; contracts: () => ContractRef[] | null };
  /** Every streamOptionQuotes call, in order (the screen opens one per scored ticker's best contract). */
  optionSubscriptions: OptionSubscription[];
  dayQuotes: { rows: LiveOptionQuote[]; loads: number; emit(tickerId: string): void };
  monteCarloCalls: { spotPrice: number; candidateCount: number }[];
  account: { freeCash: number };
  freeShares: { value: number };
  /** What the snapshot-change poll reads, and what loadTickerSignalsInputs hands out: tests change these to simulate a capture/fit landing. */
  snapshots: { versions: Map<string, string>; inputsLoads: string[]; analysing: Set<string> };
}

function createHarness(): Harness {
  let priceCallback: ((prices: Record<string, number | null>, status: { frozenPhaseComplete: boolean }) => void) | null = null;
  let quoteCallback: ((quotes: LiveOptionQuote[]) => void) | null = null;
  let quoteContracts: ContractRef[] | null = null;
  const optionSubscriptions: OptionSubscription[] = [];
  const dayQuoteListeners = new Set<(tickerId: string) => void>();
  const dayQuotes: Harness["dayQuotes"] = { rows: [], loads: 0, emit: (tickerId) => dayQuoteListeners.forEach((listener) => listener(tickerId)) };
  const monteCarloCalls: Harness["monteCarloCalls"] = [];
  const account = { freeCash: 1_000_000 };
  const freeShares = { value: 200 };
  const snapshots: Harness["snapshots"] = { versions: new Map(), inputsLoads: [], analysing: new Set() };
  const untilAbort = (signal: AbortSignal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
  const deps: SignalsProducerDependencies = {
    loadSignalsUniverseTickers: async () => [aaoi, hood],
    loadSignalsUniverseTicker: async (symbol) => (symbol === "AAOI" ? aaoi : symbol === "HOOD" ? hood : null),
    loadTickerSignalsInputs: async (ticker) => {
      snapshots.inputsLoads.push(ticker.symbol);
      const inputs = inputsFor(ticker, ticker.symbol === "AAOI", freeShares.value);
      return snapshots.analysing.has(ticker.symbol) && inputs.header ? { ...inputs, header: { ...inputs.header, fitCompletedAt: null }, slices: [] } : inputs;
    },
    loadSnapshotVersions: async (tickerIds) => new Map([...snapshots.versions].filter(([tickerId]) => tickerIds.includes(tickerId))),
    loadDayQuotes: async () => {
      dayQuotes.loads += 1;
      return dayQuotes.rows;
    },
    onDayQuotesUpdated: (listener) => {
      dayQuoteListeners.add(listener);
      return () => dayQuoteListeners.delete(listener);
    },
    loadDayQuotesStatus: async () => ({ tradingDateIso: "2026-09-21", quoteCount: dayQuotes.rows.length, oldestQuotedAt: null, newestQuotedAt: null, expiryCount: 1, tickerCount: 1 }),
    daySignalsLoopStatus: () => ({ state: "running", reason: "test", stateSince: "2026-09-22T14:00:00.000Z", tradingDateIso: "2026-09-21", cycleNumber: 3, cycleStartedAt: null, lastCycleDurationMs: 1000, contractsInPool: 4, lastError: null }),
    loadAccountContext: async () => ({ freeCash: account.freeCash }),
    loadTradingSettings: async () => ({ minAnnualizedYieldPct: 0, deltaTargetMin: 0, deltaTargetMax: 1, recoveryDteMin: 1, recoveryDteMax: 14, maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0, commissionWarnSharePctOfPremium: 5, priceCheckMaxDeviationPct: 10, priceCheckMinToleranceDollars: 0.05 }),
    fetchAvailableUncoveredShares: async () => freeShares.value,
    streamLivePrices: async (_contracts, onUpdate, signal) => {
      priceCallback = onUpdate;
      await untilAbort(signal);
    },
    streamOptionQuotes: async (symbol, contracts, onUpdate, signal) => {
      quoteContracts = contracts;
      quoteCallback = onUpdate;
      optionSubscriptions.push({ symbol, contracts, push: onUpdate, aborted: () => signal.aborted });
      await untilAbort(signal);
    },
    computeUncompensatedShares: async (candidates, spotPrice) => {
      monteCarloCalls.push({ spotPrice, candidateCount: candidates.length });
      return new Map(candidates.map((candidate) => [candidateContractKey(candidate), 42]));
    },
    loadCapturedDeltas: async () => new Map([["2026-10-21|95|P", -0.17], ["2026-10-21|100|P", -0.52]]),
    now: () => new Date(),
  };
  return {
    deps,
    priceUpdates: { push: (prices, frozenPhaseComplete) => priceCallback!(prices, { frozenPhaseComplete }) },
    quoteUpdates: { push: (quotes) => quoteCallback!(quotes), contracts: () => quoteContracts },
    optionSubscriptions,
    dayQuotes,
    monteCarloCalls,
    account,
    freeShares,
    snapshots,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("signalsScreen producer", () => {
  it("with no live price it emits every ticker at snapshot prices once the grace is over, then coalesces live re-scores to one frame per second", async () => {
    const harness = createHarness();
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    const run = signalsScreen.run({}, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs - 1);
    expect(frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(frames).toHaveLength(1);
    const aaoiRow = frames[0]!.rows.find((row) => row.symbol === "AAOI")!;
    const hoodRow = frames[0]!.rows.find((row) => row.symbol === "HOOD")!;
    expect(aaoiRow.priceSource).toBe("snapshot");
    expect(aaoiRow.spotPrice).toBe(forward);
    expect(aaoiRow.dayChangePercent).toBeNull();
    expect(aaoiRow.best).not.toBeNull();
    expect("candidates" in aaoiRow).toBe(false);
    expect(hoodRow.unscoredReason).toBe("no_snapshot");

    // Two ticks inside the same second -> exactly one more frame, carrying the latest price.
    harness.priceUpdates.push({ AAOI: 102, HOOD: 120 }, false);
    harness.priceUpdates.push({ AAOI: 103, HOOD: 120 }, false);
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames).toHaveLength(2);
    const live = frames[1]!.rows.find((row) => row.symbol === "AAOI")!;
    expect(live.spotPrice).toBe(103);
    expect(live.priceSource).toBe("frozen");
    expect(live.dayChangePercent).toBeCloseTo((103 / 98 - 1) * 100, 10);
    expect(frames[1]!.rows.find((row) => row.symbol === "HOOD")!.spotPrice).toBe(120);

    // Frozen phase ends: the same prices flip the source to live.
    harness.priceUpdates.push({ AAOI: 103, HOOD: 120 }, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames).toHaveLength(3);
    expect(frames[2]!.rows.find((row) => row.symbol === "AAOI")!.priceSource).toBe("live");

    abort.abort();
    await run;
    harness.priceUpdates.push({ AAOI: 150, HOOD: 120 }, true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(frames).toHaveLength(3);
  });

  it("holds its first frame until every ticker has a live price, then emits at once (a partial set waits for the grace)", async () => {
    const harness = createHarness();
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    void signalsScreen.run({}, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(300);
    harness.priceUpdates.push({ AAOI: 103 }, false);
    expect(frames).toHaveLength(0);
    harness.priceUpdates.push({ AAOI: 103, HOOD: 120 }, false);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.rows.find((row) => row.symbol === "AAOI")).toMatchObject({ spotPrice: 103, priceSource: "frozen" });
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs); // the grace timer adds nothing
    expect(frames).toHaveLength(1);
    abort.abort();
  });

  it("refreshes free cash every 60 s and re-scores put executability (a covered call ships both legs in one order, so shares never block it)", async () => {
    const harness = createHarness();
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    void signalsScreen.run({}, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    const bestBefore = frames[0]!.rows.find((row) => row.symbol === "AAOI")!.best!;
    expect(bestBefore.executable).toBe(true);

    harness.account.freeCash = 0;
    harness.freeShares.value = 0;
    await vi.advanceTimersByTimeAsync(58_000);
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(frames).toHaveLength(2);
    const bestAfter = frames[1]!.rows.find((row) => row.symbol === "AAOI")!.best!;
    if (bestAfter.strategyKey === "cash_secured_put") {
      expect(bestAfter.executable).toBe(false);
      expect(bestAfter.flags).toContain("insufficient_cash");
    } else {
      expect(bestAfter.executable).toBe(true);
      expect(bestAfter.flags).not.toContain("insufficient_cash");
    }
    abort.abort();
  });

  it("accepts only the bestContractLines switch as a parameter", () => {
    const { signalsScreen } = createSignalsProducers(createHarness().deps);
    expect(() => signalsScreen.parseParameters({ symbols: ["AAOI"] })).toThrow(StreamRequestError);
    expect(() => signalsScreen.parseParameters({ bestContractLines: "no" })).toThrow(StreamRequestError);
    expect(signalsScreen.parseParameters(undefined)).toEqual({});
    expect(signalsScreen.parseParameters({ bestContractLines: true })).toEqual({});
    expect(signalsScreen.parseParameters({ bestContractLines: false })).toEqual({ bestContractLines: "false" });
  });

  it("holds one pooled live line on each scored ticker's best contract, marks that row live, and opens none when the switch is off", async () => {
    const harness = createHarness();
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    void signalsScreen.run({}, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    // AAOI is scored, HOOD has no snapshot: exactly one line, on AAOI's best contract.
    expect(harness.optionSubscriptions).toHaveLength(1);
    const best = frames[0]!.rows.find((row) => row.symbol === "AAOI")!.best!;
    expect(harness.optionSubscriptions[0]).toMatchObject({ symbol: "AAOI", contracts: [{ expiry: best.expiry, strike: best.strike, right: best.strategyKey === "covered_call" ? "C" : "P" }] });
    expect(frames[0]!.dayQuotes).toEqual({ loop: expect.objectContaining({ state: "running", cycleNumber: 3 }), status: expect.objectContaining({ quoteCount: 0 }) });

    harness.optionSubscriptions[0]!.push([{ expiry: best.expiry, strike: best.strike, right: best.strategyKey === "covered_call" ? "C" : "P", bid: best.bid * 0.99, ask: best.ask * 1.01 }]);
    await vi.advanceTimersByTimeAsync(1000);
    const liveBest = frames.at(-1)!.rows.find((row) => row.symbol === "AAOI")!.best!;
    expect(liveBest.quoteSource).toBe("live");
    expect(liveBest.strike).toBe(best.strike);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.optionSubscriptions[0]!.aborted()).toBe(true);

    const off = createHarness();
    const offAbort = new AbortController();
    void createSignalsProducers(off.deps).signalsScreen.run({ bestContractLines: "false" }, { userId: "u" }, () => {}, offAbort.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(off.optionSubscriptions).toHaveLength(0);
    offAbort.abort();
  });

  it("reloads a ticker's day quotes when the loop announces them and re-scores it with source 'day'", async () => {
    const harness = createHarness();
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    void signalsScreen.run({ bestContractLines: "false" }, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    const best = frames[0]!.rows.find((row) => row.symbol === "AAOI")!.best!;
    expect(best.quoteSource).toBe("snapshot");

    harness.dayQuotes.rows = [{ expiry: best.expiry, strike: best.strike, right: best.strategyKey === "covered_call" ? "C" : "P", bid: best.bid, ask: best.ask, quotedAt: "2026-09-22T15:00:00.000Z" }];
    harness.dayQuotes.emit("id-hood"); // not scored: nothing to reload
    harness.dayQuotes.emit("id-aaoi");
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.dayQuotes.loads).toBe(1);
    const row = frames.at(-1)!.rows.find((row) => row.symbol === "AAOI")!;
    expect(row.best!.quoteSource).toBe("day");
    expect(row.best!.quotedAt).toBe("2026-09-22T15:00:00.000Z");
    expect(row.dayQuotesAsOf).toEqual({ oldest: "2026-09-22T15:00:00.000Z", newest: "2026-09-22T15:00:00.000Z", count: 1 });
    abort.abort();
  });

  it("keeps a moved line's last live quote so the best line settles instead of ping-ponging, and unhooks each retired line from the parent signal", async () => {
    const harness = createHarness();
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    void signalsScreen.run({}, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    const abortListenersAtStart = getEventListeners(abort.signal, "abort").length;
    const first = frames[0]!.rows.find((row) => row.symbol === "AAOI")!.best!;
    const firstRef: ContractRef = { expiry: first.expiry, strike: first.strike, right: first.strategyKey === "covered_call" ? "C" : "P" };
    expect(harness.optionSubscriptions).toHaveLength(1);

    // The line's own live market goes wide (spread friction sinks its net edge): the line moves to the new best contract.
    harness.optionSubscriptions[0]!.push([{ ...firstRef, bid: first.bid * 0.5, ask: first.ask * 3 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.optionSubscriptions).toHaveLength(2);
    expect(harness.optionSubscriptions[0]!.aborted()).toBe(true);
    const second = frames.at(-1)!.rows.find((row) => row.symbol === "AAOI")!.best!;
    const secondRef: ContractRef = { expiry: second.expiry, strike: second.strike, right: second.strategyKey === "covered_call" ? "C" : "P" };
    expect(contractKey(secondRef)).not.toBe(contractKey(firstRef));
    expect(harness.optionSubscriptions[1]!.contracts.map(contractKey)).toEqual([contractKey(secondRef)]);

    // The new line quotes exactly its snapshot values. The first contract's wide live market is still
    // held, so its stale snapshot cannot win the line back: no third subscription, no flip.
    harness.optionSubscriptions[1]!.push([{ ...secondRef, bid: second.bid, ask: second.ask }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.optionSubscriptions).toHaveLength(2);
    expect(harness.optionSubscriptions[1]!.aborted()).toBe(false);
    const settled = frames.at(-1)!.rows.find((row) => row.symbol === "AAOI")!.best!;
    expect([settled.expiry, settled.strike]).toEqual([second.expiry, second.strike]);

    // A day-quote reload drops the retired contract's stale live reading; on fresh day quotes it wins the line back.
    harness.dayQuotes.rows = [{ ...firstRef, bid: first.bid, ask: first.ask, quotedAt: "2026-09-22T15:00:00.000Z" }];
    harness.dayQuotes.emit("id-aaoi");
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.optionSubscriptions).toHaveLength(3);
    expect(harness.optionSubscriptions[1]!.aborted()).toBe(true);
    expect(harness.optionSubscriptions[2]!.contracts.map(contractKey)).toEqual([contractKey(firstRef)]);

    // Two retired lines later the parent signal carries exactly the listeners it started with (one per live line).
    expect(getEventListeners(abort.signal, "abort").length).toBe(abortListenersAtStart);
    abort.abort();
  });
});

describe("signalsTicker producer", () => {
  it("validates parameters: symbol required and upper-cased, expiry optional ISO date, nothing else", () => {
    const { signalsTicker } = createSignalsProducers(createHarness().deps);
    expect(signalsTicker.parseParameters({ symbol: "aaoi" })).toEqual({ symbol: "AAOI" });
    expect(signalsTicker.parseParameters({ symbol: "AAOI", expiry: "2026-10-21" })).toEqual({ symbol: "AAOI", expiry: "2026-10-21" });
    expect(() => signalsTicker.parseParameters({})).toThrow(StreamRequestError);
    expect(() => signalsTicker.parseParameters({ symbol: "AAOI", expiry: "20261021" })).toThrow(StreamRequestError);
    expect(() => signalsTicker.parseParameters({ symbol: "AAOI", other: 1 })).toThrow(StreamRequestError);
  });

  it("fails with 404 for a symbol not on the shortlist", async () => {
    const { signalsTicker } = createSignalsProducers(createHarness().deps);
    await expect(signalsTicker.run({ symbol: "NVDA" }, { userId: "u" }, () => {}, new AbortController().signal)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("holds its first frame for the live price; with none it goes out at the snapshot prices after the grace, holding no option lines (only the stock)", async () => {
    const harness = createHarness();
    const { signalsTicker } = createSignalsProducers(harness.deps);
    const frames: SignalsTickerFrame[] = [];
    const abort = new AbortController();
    void signalsTicker.run({ symbol: "AAOI", expiry: "2026-11-20" }, { userId: "u" }, (frame) => frames.push(frame as SignalsTickerFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs - 1);
    expect(frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(frames).toHaveLength(1);
    const first = frames[0]!;
    expect(first.signals.candidates).toHaveLength(4);
    expect(first.signals.priceSource).toBe("snapshot");
    // The Monte Carlo waits for a price too (with none it runs at the snapshot spot once the grace is over); its frame follows.
    expect(first.uncompensatedAsOf).toBeNull();
    expect(harness.monteCarloCalls).toEqual([{ spotPrice: forward, candidateCount: 4 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.uncompensatedAsOf).toEqual({ spotPrice: forward, at: expect.any(String) });
    expect(frames[1]!.signals.candidates.every((c) => c.uncompensatedSharePercent === 42)).toBe(true);
    // Option lines belong to the signalsQuotes stream (what is on screen); this one holds none.
    expect(harness.optionSubscriptions).toEqual([]);
    abort.abort();
  });

  it("emits its first frame as soon as the live price arrives, never one at the stale snapshot spot before it", async () => {
    const harness = createHarness();
    const { signalsTicker } = createSignalsProducers(harness.deps);
    const frames: SignalsTickerFrame[] = [];
    const abort = new AbortController();
    void signalsTicker.run({ symbol: "AAOI" }, { userId: "u" }, (frame) => frames.push(frame as SignalsTickerFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(300);
    expect(frames).toHaveLength(0);
    harness.priceUpdates.push({ AAOI: 103 }, true);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.signals.spotPrice).toBe(103);
    expect(frames[0]!.signals.priceSource).toBe("live");
    // The Monte Carlo ran at the live spot (never at the snapshot's) and its result is the only later frame; the grace timer adds none.
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    expect(harness.monteCarloCalls).toEqual([{ spotPrice: 103, candidateCount: expect.any(Number) }]);
    expect(frames.every((frame) => frame.signals.priceSource === "live")).toBe(true);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.uncompensatedAsOf).toEqual({ spotPrice: 103, at: expect.any(String) });
    abort.abort();
  });

  it("re-runs the Monte Carlo every 5 s only after a >= 0.5% spot move, never overlapping", async () => {
    const harness = createHarness();
    const { signalsTicker } = createSignalsProducers(harness.deps);
    const frames: SignalsTickerFrame[] = [];
    const abort = new AbortController();
    void signalsTicker.run({ symbol: "AAOI" }, { userId: "u" }, (frame) => frames.push(frame as SignalsTickerFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    harness.priceUpdates.push({ AAOI: forward }, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.monteCarloCalls).toHaveLength(1);

    harness.priceUpdates.push({ AAOI: 100.3 }, true); // +0.3%: below the gate
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.monteCarloCalls).toHaveLength(1);
    expect(frames.at(-1)!.signals.spotPrice).toBe(100.3);
    expect(frames.at(-1)!.uncompensatedAsOf!.spotPrice).toBe(forward);

    harness.priceUpdates.push({ AAOI: 100.6 }, true); // +0.6% from the last simulation
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.monteCarloCalls).toHaveLength(2);
    expect(harness.monteCarloCalls[1]!.spotPrice).toBe(100.6);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames.at(-1)!.uncompensatedAsOf!.spotPrice).toBe(100.6);

    await vi.advanceTimersByTimeAsync(20_000); // quiet: no further runs
    expect(harness.monteCarloCalls).toHaveLength(2);
    abort.abort();
  });
});

describe("signalsQuotes producer (what the modal has on screen)", () => {
  const run = (harness: Harness, contracts: string[], pinned?: string[]) => {
    const { signalsQuotes } = createSignalsProducers(harness.deps);
    const frames: SignalsQuotesFrame[] = [];
    const abort = new AbortController();
    void signalsQuotes.run(signalsQuotes.parseParameters({ symbol: "AAOI", contracts, ...(pinned ? { pinned } : {}) }), { userId: "u" }, (frame) => frames.push(frame as SignalsQuotesFrame), abort.signal);
    return { frames, abort };
  };

  it("validates its parameters", () => {
    const { signalsQuotes } = createSignalsProducers(createHarness().deps);
    expect(signalsQuotes.parseParameters({ symbol: "aaoi", contracts: ["2026-10-21|90|P", "2026-10-21|90|P", "2026-10-21|197.5|C"] })).toEqual({ symbol: "AAOI", contracts: "2026-10-21|90|P,2026-10-21|197.5|C" });
    expect(signalsQuotes.parseParameters({ symbol: "AAOI", contracts: [] })).toEqual({ symbol: "AAOI", contracts: "" });
    expect(() => signalsQuotes.parseParameters({ symbol: "AAOI", contracts: ["20261021|90|P"] })).toThrow(StreamRequestError);
    expect(() => signalsQuotes.parseParameters({ symbol: "AAOI", contracts: "2026-10-21|90|P" })).toThrow(StreamRequestError);
    expect(signalsQuotes.parseParameters({ symbol: "AAOI", contracts: [], pinned: ["2026-10-21|95|P", "2026-10-21|95|P"] })).toEqual({ symbol: "AAOI", contracts: "", pinned: "2026-10-21|95|P" });
    expect(() => signalsQuotes.parseParameters({ symbol: "AAOI", contracts: [], pinned: ["nope"] })).toThrow(StreamRequestError);
    expect(() => signalsQuotes.parseParameters({ symbol: "AAOI", contracts: [], pinned: Array.from({ length: 5 }, (_, index) => `2026-10-21|${index + 1}|P`) })).toThrow(StreamRequestError);
    expect(() => signalsQuotes.parseParameters({ symbol: "AAOI", contracts: Array.from({ length: 61 }, (_, index) => `2026-10-21|${index}|P`) })).toThrow(StreamRequestError);
  });

  it("subscribes exactly the requested contracts and re-scores them live; a contract the snapshot never stored gets a cell once quoted", async () => {
    const harness = createHarness();
    const { frames, abort } = run(harness, ["2026-10-21|90|P", "2026-10-21|95|P"]);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    expect(harness.optionSubscriptions.map((subscription) => subscription.contracts.map(contractKey))).toEqual([["2026-10-21|90|P", "2026-10-21|95|P"]]);
    const before = frames[0]!.candidates["2026-10-21|90|P"]!;
    expect(before.quoteSource).toBe("snapshot");
    expect(frames[0]!.cells["2026-10-21|95|P"]).toBeUndefined(); // not in the snapshot, no quote yet

    const fresh95 = quoteAt(95, "P", "2026-10-21", years30);
    harness.quoteUpdates.push([
      { expiry: "2026-10-21", strike: 90, right: "P", bid: before.bid * 0.8, ask: before.ask * 1.2 },
      { expiry: "2026-10-21", strike: 95, right: "P", bid: fresh95.bid, ask: fresh95.ask },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    const last = frames.at(-1)!;
    expect(last.candidates["2026-10-21|90|P"]!.quoteSource).toBe("live");
    expect(last.candidates["2026-10-21|90|P"]!.netEdge).toBeLessThan(before.netEdge);
    expect(last.cells["2026-10-21|95|P"]).toMatchObject({ quoteSource: "live", bid: fresh95.bid });
    expect(Object.keys(last.candidates).every((key) => key.startsWith("2026-10-21|9"))).toBe(true); // only what was asked for
    abort.abort();
    expect(harness.optionSubscriptions[0]!.aborted()).toBe(true);
  });

  it("a filtered cell shows the capture's delta without a pin, then takes the streamed IBKR delta once the line carries one", async () => {
    const harness = createHarness();
    const { frames, abort } = run(harness, ["2026-10-21|100|P"]);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    expect(frames[0]!.cells["2026-10-21|100|P"]).toBeUndefined(); // not in the snapshot, no quote yet

    const stored100 = quoteAt(100, "P", "2026-10-21", years30);
    harness.quoteUpdates.push([{ expiry: "2026-10-21", strike: 100, right: "P", bid: stored100.bid, ask: stored100.ask }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames.at(-1)!.cells["2026-10-21|100|P"]).toMatchObject({ state: "filtered", delta: -0.52 });

    harness.quoteUpdates.push([{ expiry: "2026-10-21", strike: 100, right: "P", bid: stored100.bid, ask: stored100.ask, delta: -0.55 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames.at(-1)!.cells["2026-10-21|100|P"]).toMatchObject({ state: "filtered", delta: -0.55 });

    harness.quoteUpdates.push([{ expiry: "2026-10-21", strike: 100, right: "P", bid: stored100.bid, ask: stored100.ask, delta: null }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames.at(-1)!.cells["2026-10-21|100|P"]).toMatchObject({ state: "filtered", delta: -0.52 });
    abort.abort();
  });

  it("a pinned contract gets its own line on top of the on-screen ones and is scored live like the contract endpoint, Monte Carlo included", async () => {
    const harness = createHarness();
    const { frames, abort } = run(harness, ["2026-10-21|90|P"], ["2026-10-21|95|P", "2026-10-21|90|P"]);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    expect(harness.optionSubscriptions.map((subscription) => subscription.contracts.map(contractKey))).toEqual([["2026-10-21|90|P", "2026-10-21|95|P"]]);
    // Nothing quoted yet for the contract the snapshot never stored: unscored, with the capture's delta.
    expect(frames[0]!.pinned["2026-10-21|95|P"]).toMatchObject({ scored: false, delta: -0.17 });

    const fresh95 = quoteAt(95, "P", "2026-10-21", years30);
    harness.quoteUpdates.push([{ expiry: "2026-10-21", strike: 95, right: "P", bid: fresh95.bid, ask: fresh95.ask, delta: -0.19 }]);
    await vi.advanceTimersByTimeAsync(1000);
    const scoredFrame = frames.at(-1)!;
    expect(scoredFrame.pinned["2026-10-21|95|P"]).toMatchObject({ scored: true, quoteSource: "live", bid: fresh95.bid });
    // The simulation runs in the worker once for the pinned candidates (the 90 put and the 95 put), then its result lands in a later frame.
    expect(harness.monteCarloCalls.at(-1)).toEqual({ spotPrice: forward, candidateCount: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames.at(-1)!.pinned["2026-10-21|95|P"]).toMatchObject({ scored: true, uncompensatedSharePercent: 42 });

    // A new quote at the same spot re-scores the pinned contract without another simulation.
    const callsBefore = harness.monteCarloCalls.length;
    harness.quoteUpdates.push([{ expiry: "2026-10-21", strike: 95, right: "P", bid: fresh95.bid! * 0.9, ask: fresh95.ask, delta: -0.19 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames.at(-1)!.pinned["2026-10-21|95|P"]).toMatchObject({ scored: true, bid: fresh95.bid! * 0.9 });
    expect(harness.monteCarloCalls).toHaveLength(callsBefore);
    abort.abort();
  });

  it("holds its first frame for the live price, so nothing is ever scored at the stale snapshot spot", async () => {
    const harness = createHarness();
    const { frames, abort } = run(harness, ["2026-10-21|90|P"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(frames).toHaveLength(0);
    harness.priceUpdates.push({ AAOI: 103 }, true);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.spotPrice).toBe(103);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    expect(frames).toHaveLength(1);
    abort.abort();
  });

  it("holds no option line for an empty list (nothing on screen)", async () => {
    const harness = createHarness();
    const { frames, abort } = run(harness, []);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    expect(harness.optionSubscriptions).toEqual([]);
    expect(frames[0]!.cells).toEqual({});
    abort.abort();
  });
});

describe("snapshot-change poll (a stream opened mid-capture must not stay half-finished)", () => {
  it("screen: a ticker opened while its fit is pending is Analysing, and becomes scored on the first poll after its fit lands, without reloading the others", async () => {
    const harness = createHarness();
    harness.snapshots.analysing.add("AAOI");
    harness.snapshots.versions.set("id-aaoi", "snap-1|pending");
    harness.snapshots.versions.set("id-hood", "snap-h|2026-09-22T14:00:00.000Z");
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    void signalsScreen.run({}, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    expect(frames.at(-1)!.rows.find((row) => row.symbol === "AAOI")).toMatchObject({ unscoredReason: "analysing", best: null, unscoredDetail: { kind: "analysing" } });
    expect(harness.snapshots.inputsLoads).toEqual(["AAOI", "HOOD"]);

    // Nothing changed: a poll reloads nothing.
    await vi.advanceTimersByTimeAsync(snapshotChangePollIntervalMs);
    expect(harness.snapshots.inputsLoads).toEqual(["AAOI", "HOOD"]);

    // The fit lands: the next poll reloads only AAOI and the row is scored.
    harness.snapshots.analysing.delete("AAOI");
    harness.snapshots.versions.set("id-aaoi", "snap-1|2026-09-22T14:01:00.000Z");
    await vi.advanceTimersByTimeAsync(snapshotChangePollIntervalMs);
    await vi.advanceTimersByTimeAsync(liveFrameIntervalMs);
    expect(harness.snapshots.inputsLoads).toEqual(["AAOI", "HOOD", "AAOI"]);
    const aaoi = frames.at(-1)!.rows.find((row) => row.symbol === "AAOI")!;
    expect(aaoi.unscoredReason).toBeNull();
    expect(aaoi.best).not.toBeNull();
    abort.abort();
  });

  it("screen: a stream that opened before the capture picks up the new snapshot of a ticker and keeps polling", async () => {
    const harness = createHarness();
    harness.snapshots.versions.set("id-aaoi", "snap-old|2026-09-21T14:00:00.000Z");
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    void signalsScreen.run({}, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    expect(harness.snapshots.inputsLoads).toEqual(["AAOI", "HOOD"]);
    harness.snapshots.versions.set("id-aaoi", "snap-new|pending");
    harness.snapshots.analysing.add("AAOI");
    await vi.advanceTimersByTimeAsync(snapshotChangePollIntervalMs);
    await vi.advanceTimersByTimeAsync(liveFrameIntervalMs);
    expect(frames.at(-1)!.rows.find((row) => row.symbol === "AAOI")!.unscoredReason).toBe("analysing");
    harness.snapshots.analysing.delete("AAOI");
    harness.snapshots.versions.set("id-aaoi", "snap-new|2026-09-22T14:01:00.000Z");
    await vi.advanceTimersByTimeAsync(snapshotChangePollIntervalMs);
    await vi.advanceTimersByTimeAsync(liveFrameIntervalMs);
    expect(frames.at(-1)!.rows.find((row) => row.symbol === "AAOI")!.unscoredReason).toBeNull();
    abort.abort();
  });

  it("ticker stream: reloads its inputs when the snapshot version changes", async () => {
    const harness = createHarness();
    harness.snapshots.analysing.add("AAOI");
    harness.snapshots.versions.set("id-aaoi", "snap-1|pending");
    const { signalsTicker } = createSignalsProducers(harness.deps);
    const frames: SignalsTickerFrame[] = [];
    const abort = new AbortController();
    void signalsTicker.run({ symbol: "AAOI" }, { userId: "u" }, (frame) => frames.push(frame as SignalsTickerFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(firstFramePriceGraceMs);
    expect(frames.at(-1)!.signals.unscoredReason).toBe("analysing");
    harness.snapshots.analysing.delete("AAOI");
    harness.snapshots.versions.set("id-aaoi", "snap-1|2026-09-22T14:01:00.000Z");
    await vi.advanceTimersByTimeAsync(snapshotChangePollIntervalMs);
    await vi.advanceTimersByTimeAsync(liveFrameIntervalMs);
    expect(frames.at(-1)!.signals.unscoredReason).toBeNull();
    expect(frames.at(-1)!.signals.best).not.toBeNull();
    abort.abort();
  });
});
