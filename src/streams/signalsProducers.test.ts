import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "../lib/impliedVolatilitySurface.js";
import type { SignalQuote, SignalSurfaceSlice } from "../lib/signalCandidates.js";
import { candidateContractKey, contractKey, type ContractRef, type LiveOptionQuote } from "../lib/signalsLiveScoring.js";
import type { ShortlistTickerRow } from "../lib/signalsStore.js";
import type { TickerSignalsInputs } from "../lib/signalsTypes.js";
import { createSignalsProducers, type SignalsProducerDependencies, type SignalsScreenFrame, type SignalsTickerFrame } from "./signalsProducers.js";
import { StreamRequestError } from "./streamProtocol.js";

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const years30 = 30 / 365;
const years60 = 60 / 365;
const slice = (expiry: string, years: number): SignalSurfaceSlice => ({ expiry, status: "ok", parameters: params, kMin: -0.4, kMax: 0.4, yearsToExpiry: years, forwardPrice: forward });
function quoteAt(strike: number, right: "C" | "P", expiry: string, years: number): SignalQuote {
  const iv = Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years);
  const mid = blackScholesPriceOnForward(forward, strike, years, rate, iv, right === "C");
  return { expiry, strike, right, bid: mid * 0.98, ask: mid * 1.02, source: "snapshot" };
}
const aaoi: ShortlistTickerRow = { tickerId: "id-aaoi", symbol: "AAOI", companyName: "Applied Opto", sector: "Tech" };
const hood: ShortlistTickerRow = { tickerId: "id-hood", symbol: "HOOD", companyName: "Robinhood", sector: null };

function inputsFor(ticker: ShortlistTickerRow, withSnapshot: boolean, freeShares = 200): TickerSignalsInputs {
  return {
    ...ticker,
    header: withSnapshot ? { snapshotId: "s1", tradingDateIso: "2026-09-21", capturedAt: "2026-09-21T14:00:00Z", underlyingPrice: forward, riskFreeRatePercent: rate * 100 } : null,
    slices: withSnapshot ? [slice("2026-10-21", years30), slice("2026-11-20", years60)] : [],
    quotes: withSnapshot ? [quoteAt(90, "P", "2026-10-21", years30), quoteAt(110, "C", "2026-10-21", years30), quoteAt(85, "P", "2026-11-20", years60), quoteAt(115, "C", "2026-11-20", years60)] : [],
    forecast: withSnapshot ? { volatility: 0.15, windowDays: 63 } : null,
    earningsDatesIso: [],
    momentum: 0.1,
    elevatedVolatility: null,
    skew: null,
    nextEarningsDateIso: null,
    previousClose: { close: 98, dateIso: "2026-09-21" },
    freeShares,
    dailyBarCount: 1253,
    hasDividendEvents: false,
    todayEasternIso: "2026-09-22",
  };
}

interface Harness {
  deps: SignalsProducerDependencies;
  priceUpdates: { push(prices: Record<string, number | null>, frozenPhaseComplete: boolean): void };
  quoteUpdates: { push(quotes: LiveOptionQuote[]): void; contracts: () => ContractRef[] | null };
  monteCarloCalls: { spotPrice: number; candidateCount: number }[];
  account: { freeCash: number };
  freeShares: { value: number };
}

function createHarness(): Harness {
  let priceCallback: ((prices: Record<string, number | null>, status: { frozenPhaseComplete: boolean }) => void) | null = null;
  let quoteCallback: ((quotes: LiveOptionQuote[]) => void) | null = null;
  let quoteContracts: ContractRef[] | null = null;
  const monteCarloCalls: Harness["monteCarloCalls"] = [];
  const account = { freeCash: 1_000_000 };
  const freeShares = { value: 200 };
  const untilAbort = (signal: AbortSignal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
  const deps: SignalsProducerDependencies = {
    loadShortlistTickers: async () => [aaoi, hood],
    loadShortlistTicker: async (symbol) => (symbol === "AAOI" ? aaoi : symbol === "HOOD" ? hood : null),
    loadTickerSignalsInputs: async (ticker) => inputsFor(ticker, ticker.symbol === "AAOI", freeShares.value),
    loadAccountContext: async () => ({ freeCash: account.freeCash }),
    fetchAvailableUncoveredShares: async () => freeShares.value,
    streamLivePrices: async (_contracts, onUpdate, signal) => {
      priceCallback = onUpdate;
      await untilAbort(signal);
    },
    streamOptionQuotes: async (_symbol, contracts, onUpdate, signal) => {
      quoteContracts = contracts;
      quoteCallback = onUpdate;
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

  it("refreshes free cash and shares every 60 s and re-scores executability", async () => {
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
    expect(bestAfter.executable).toBe(false);
    expect(bestAfter.flags).toContain(bestAfter.strategyKey === "covered_call" ? "no_shares" : "insufficient_cash");
    abort.abort();
  });

  it("rejects parameters", () => {
    const { signalsScreen } = createSignalsProducers(createHarness().deps);
    expect(() => signalsScreen.parseParameters({ symbols: ["AAOI"] })).toThrow(StreamRequestError);
    expect(signalsScreen.parseParameters(undefined)).toEqual({});
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

  it("first frame at snapshot prices, subscribes the selected expiry's contracts plus the top-ranked, then fills the Monte Carlo", async () => {
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
    // Selected expiry first, then the rest by rank; the same set is what was subscribed live.
    expect(first.liveQuoteContracts.slice(0, 2).sort()).toEqual(["2026-11-20|115|C", "2026-11-20|85|P"].sort());
    expect(first.liveQuoteContracts).toHaveLength(4);
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
