import { describe, expect, it } from "vitest";
import {
  computeSnapshotCoverage,
  deriveMarketDataType,
  deriveSnapshotStatus,
  isTickerStarved,
  optionChainCaptureBatchSize,
  recaptureMaximumElapsedMs,
  shouldRecaptureStarvedTicker,
  splitIntoBatches,
  type CoverageQuoteInput,
} from "./optionChainCaptureCoverage.js";
import { buildQuoteRows, formatExpiryAsIsoDate, type OptionQuoteToStore } from "./optionChainSnapshotStore.js";

function quote(overrides: Partial<CoverageQuoteInput> = {}): CoverageQuoteInput {
  return { receivedAnyTick: true, bid: 1, ask: 1.1, impliedVolatility: 0.5, delta: 0.3, sawRealTimeTicks: true, sawDelayedTicks: false, ...overrides };
}
const silent = () => quote({ receivedAnyTick: false, bid: null, ask: null, impliedVolatility: null, delta: null, sawRealTimeTicks: false });

describe("splitIntoBatches", () => {
  it("defaults to the approved 60 lines per batch", () => {
    expect(optionChainCaptureBatchSize).toBe(60);
    const batches = splitIntoBatches(Array.from({ length: 130 }, (_, i) => i));
    expect(batches.map((batch) => batch.length)).toEqual([60, 60, 10]);
    expect(batches.flat()).toEqual(Array.from({ length: 130 }, (_, i) => i));
  });

  it("returns no batches for no items and one short batch for a few", () => {
    expect(splitIntoBatches([])).toEqual([]);
    expect(splitIntoBatches([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it("rejects a nonsensical batch size", () => {
    expect(() => splitIntoBatches([1], 0)).toThrow(RangeError);
    expect(() => splitIntoBatches([1], 2.5)).toThrow(RangeError);
  });
});

describe("computeSnapshotCoverage", () => {
  it("counts requested, any-tick, two-sided quotes, and IV-with-delta separately", () => {
    const coverage = computeSnapshotCoverage([
      quote(),
      quote({ bid: null }), // one-sided: has ticks and IV, not two-sided
      quote({ impliedVolatility: null }), // no IV
      quote({ delta: null }), // IV but no delta → not counted as IV+delta
      quote({ ask: null }), // bid but no ask: also one-sided
      silent(),
    ]);
    expect(coverage).toEqual({ contractsRequested: 6, contractsWithAnyTick: 5, contractsWithTwoSidedQuote: 3, contractsWithImpliedVolatility: 3 });
  });
});

describe("starved-ticker rule (fewer than 90% of contracts with any tick)", () => {
  const coverageOf = (withTick: number, requested: number) => ({
    contractsRequested: requested,
    contractsWithAnyTick: withTick,
    contractsWithTwoSidedQuote: 0,
    contractsWithImpliedVolatility: 0,
  });

  it("is not starved at exactly 90%, and starved just below", () => {
    expect(isTickerStarved(coverageOf(90, 100))).toBe(false);
    expect(isTickerStarved(coverageOf(89, 100))).toBe(true);
  });

  it("does not count missing bids against a ticker: far-OTM contracts with ticks but no bid are still covered", () => {
    const coverage = computeSnapshotCoverage(Array.from({ length: 10 }, () => quote({ bid: null })));
    expect(isTickerStarved(coverage)).toBe(false);
  });

  it("is not starved when nothing was requested (a different problem)", () => {
    expect(isTickerStarved(coverageOf(0, 0))).toBe(false);
  });

  it("re-captures a starved ticker only while the job is inside the 45-minute budget", () => {
    const starved = coverageOf(10, 100);
    expect(shouldRecaptureStarvedTicker(starved, 0)).toBe(true);
    expect(shouldRecaptureStarvedTicker(starved, recaptureMaximumElapsedMs - 1)).toBe(true);
    expect(shouldRecaptureStarvedTicker(starved, recaptureMaximumElapsedMs)).toBe(false);
    expect(shouldRecaptureStarvedTicker(coverageOf(100, 100), 0)).toBe(false);
  });
});

describe("deriveSnapshotStatus", () => {
  const coverageOf = (withTick: number, requested: number) => ({
    contractsRequested: requested,
    contractsWithAnyTick: withTick,
    contractsWithTwoSidedQuote: 0,
    contractsWithImpliedVolatility: 0,
  });
  it("is complete, partial or failed", () => {
    expect(deriveSnapshotStatus(coverageOf(95, 100))).toBe("complete");
    expect(deriveSnapshotStatus(coverageOf(50, 100))).toBe("partial");
    expect(deriveSnapshotStatus(coverageOf(0, 100))).toBe("failed");
    expect(deriveSnapshotStatus(coverageOf(0, 0))).toBe("failed");
  });
});

describe("deriveMarketDataType", () => {
  it("judges from the tick types that arrived", () => {
    expect(deriveMarketDataType([quote()])).toBe("real_time");
    expect(deriveMarketDataType([quote({ sawRealTimeTicks: false, sawDelayedTicks: true })])).toBe("delayed");
    expect(deriveMarketDataType([quote(), quote({ sawRealTimeTicks: false, sawDelayedTicks: true })])).toBe("mixed");
    expect(deriveMarketDataType([silent()])).toBe("unknown");
    expect(deriveMarketDataType([])).toBe("unknown");
  });
});

describe("formatExpiryAsIsoDate and buildQuoteRows", () => {
  const stored = (overrides: Partial<OptionQuoteToStore> = {}): OptionQuoteToStore => ({
    expiry: "20260925",
    strike: 100,
    right: "P",
    bid: 1.1,
    ask: 1.2,
    last: null,
    bidSize: 40,
    askSize: 25,
    impliedVolatility: 0.61,
    delta: -0.31,
    gamma: null,
    vega: null,
    theta: null,
    modelOptionPrice: null,
    underlyingPrice: 101.25,
    openInterest: 1520,
    volume: 88,
    ...overrides,
  });

  it("converts IBKR's YYYYMMDD to an ISO date and rejects anything else", () => {
    expect(formatExpiryAsIsoDate("20261002")).toBe("2026-10-02");
    expect(() => formatExpiryAsIsoDate("2026-10-02")).toThrow();
  });

  it("maps every field to its column", () => {
    const [row] = buildQuoteRows("snap-1", [stored()]);
    expect(row).toMatchObject({
      snapshot_id: "snap-1",
      expiry: "2026-09-25",
      strike: 100,
      option_right: "P",
      bid: 1.1,
      ask: 1.2,
      bid_size: 40,
      ask_size: 25,
      implied_volatility: 0.61,
      delta: -0.31,
      underlying_price: 101.25,
      open_interest: 1520,
      volume: 88,
    });
  });

  it("keeps a call and a put at the same expiry and strike as two separate rows", () => {
    const rows = buildQuoteRows("snap-1", [stored({ right: "P" }), stored({ right: "C" })]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.option_right).sort()).toEqual(["C", "P"]);
  });

  it("collapses a contract seen twice (first pass + re-capture) to its last occurrence", () => {
    const rows = buildQuoteRows("snap-1", [stored({ bid: null }), stored({ strike: 105, right: "C" }), stored({ bid: 1.3 })]);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.option_right === "P")).toMatchObject({ bid: 1.3 });
  });
});
