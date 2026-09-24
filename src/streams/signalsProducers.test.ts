import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "../lib/impliedVolatilitySurface.js";
import type { SignalQuote, SignalSurfaceSlice } from "../lib/signalCandidates.js";
import { candidateContractKey, contractKey, type ContractRef, type LiveOptionQuote } from "../lib/signalsLiveScoring.js";
import type { SignalsTickerRow } from "../lib/signalsStore.js";
import type { TickerSignalsInputs } from "../lib/signalsTypes.js";
import { createSignalsProducers, type SignalsProducerDependencies, type SignalsScreenFrame, type SignalsTickerFrame } from "./signalsProducers.js";
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
    header: withSnapshot ? { snapshotId: "s1", tradingDateIso: "2026-09-21", capturedAt: "2026-09-21T14:00:00Z", underlyingPrice: forward, riskFreeRatePercent: rate * 100 } : null,
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
  const untilAbort = (signal: AbortSignal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
  const deps: SignalsProducerDependencies = {
    loadSignalsUniverseTickers: async () => [aaoi, hood],
    loadSignalsUniverseTicker: async (symbol) => (symbol === "AAOI" ? aaoi : symbol === "HOOD" ? hood : null),
    loadTickerSignalsInputs: async (ticker) => inputsFor(ticker, ticker.symbol === "AAOI", freeShares.value),
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
    loadSignalSettings: async () => ({ maxDeltaDriftPct: 100, minAnnualizedYieldPct: 0, maxNetDelta: 1, maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0 }),
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
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("signalsScreen producer", () => {
  it("emits every ticker at snapshot prices immediately, then coalesces live re-scores to one frame per second", async () => {
    const harness = createHarness();
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    const run = signalsScreen.run({}, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(0);

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

  it("refreshes free cash every 60 s and re-scores put executability (a covered call ships both legs in one order, so shares never block it)", async () => {
    const harness = createHarness();
    const { signalsScreen } = createSignalsProducers(harness.deps);
    const frames: SignalsScreenFrame[] = [];
    const abort = new AbortController();
    void signalsScreen.run({}, { userId: "u" }, (frame) => frames.push(frame as SignalsScreenFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    const bestBefore = frames[0]!.rows.find((row) => row.symbol === "AAOI")!.best!;
    expect(bestBefore.executable).toBe(true);

    harness.account.freeCash = 0;
    harness.freeShares.value = 0;
    await vi.advanceTimersByTimeAsync(59_000);
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
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
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

  it("first frame at snapshot prices, subscribes the selected expiry's contracts only, then fills the Monte Carlo", async () => {
    const harness = createHarness();
    const { signalsTicker } = createSignalsProducers(harness.deps);
    const frames: SignalsTickerFrame[] = [];
    const abort = new AbortController();
    void signalsTicker.run({ symbol: "AAOI", expiry: "2026-11-20" }, { userId: "u" }, (frame) => frames.push(frame as SignalsTickerFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(frames).toHaveLength(1);
    const first = frames[0]!;
    expect(first.signals.candidates).toHaveLength(4);
    expect(first.signals.priceSource).toBe("snapshot");
    expect(first.uncompensatedAsOf).toBeNull();
    expect(first.signals.candidates.every((c) => c.uncompensatedSharePercent === null)).toBe(true);
    // The selected expiry's contracts only; the same set is what was subscribed live.
    expect([...first.liveQuoteContracts].sort()).toEqual(["2026-11-20|115|C", "2026-11-20|85|P"].sort());
    expect(harness.quoteUpdates.contracts()!.map(contractKey)).toEqual(first.liveQuoteContracts);

    // The Monte Carlo ran once at the snapshot spot; its frame arrives after the 1 s throttle.
    expect(harness.monteCarloCalls).toEqual([{ spotPrice: forward, candidateCount: 4 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.uncompensatedAsOf).toEqual({ spotPrice: forward, at: expect.any(String) });
    expect(frames[1]!.signals.candidates.every((c) => c.uncompensatedSharePercent === 42)).toBe(true);
    abort.abort();
  });

  it("live quotes re-score their own contracts and are marked live; the rest keep snapshot quotes", async () => {
    const harness = createHarness();
    const { signalsTicker } = createSignalsProducers(harness.deps);
    const frames: SignalsTickerFrame[] = [];
    const abort = new AbortController();
    void signalsTicker.run({ symbol: "AAOI" }, { userId: "u" }, (frame) => frames.push(frame as SignalsTickerFrame), abort.signal);
    await vi.advanceTimersByTimeAsync(1000);
    const before = frames.at(-1)!.signals.candidates.find((c) => c.strike === 90)!;

    harness.quoteUpdates.push([{ expiry: "2026-10-21", strike: 90, right: "P", bid: before.bid * 0.8, ask: before.ask * 1.2 }]);
    await vi.advanceTimersByTimeAsync(1000);
    const after = frames.at(-1)!.signals.candidates.find((c) => c.strike === 90)!;
    expect(after.quoteSource).toBe("live");
    expect(after.bid).toBeCloseTo(before.bid * 0.8, 10);
    expect(after.netEdge).toBeLessThan(before.netEdge);
    expect(frames.at(-1)!.signals.candidates.find((c) => c.strike === 110)!.quoteSource).toBe("snapshot");
    expect(after.uncompensatedSharePercent).toBe(42); // carried across the re-score
    abort.abort();
  });

  it("re-runs the Monte Carlo every 5 s only after a >= 0.5% spot move, never overlapping", async () => {
    const harness = createHarness();
    const { signalsTicker } = createSignalsProducers(harness.deps);
    const frames: SignalsTickerFrame[] = [];
    const abort = new AbortController();
    void signalsTicker.run({ symbol: "AAOI" }, { userId: "u" }, (frame) => frames.push(frame as SignalsTickerFrame), abort.signal);
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
