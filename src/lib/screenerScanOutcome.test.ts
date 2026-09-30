import { describe, expect, it } from "vitest";
import { buildScreenerFailureMessage, isEmptyEnrichment, type EnrichmentQuote } from "./screenerScanOutcome.js";

const quote = (overrides: Partial<EnrichmentQuote> = {}): EnrichmentQuote => ({
  lastPrice: null,
  avgShareVolume: null,
  avgOptionVolume: null,
  callOpenInterest: null,
  putOpenInterest: null,
  bidAskSpreadPct: null,
  impliedVolatility: null,
  ...overrides,
});

describe("isEmptyEnrichment", () => {
  it("is true only when every field is null (a timed-out enrichment)", () => {
    expect(isEmptyEnrichment(quote())).toBe(true);
    expect(isEmptyEnrichment(quote({ lastPrice: 12.5 }))).toBe(false);
    expect(isEmptyEnrichment(quote({ impliedVolatility: 0 }))).toBe(false);
  });
});

describe("buildScreenerFailureMessage", () => {
  const healthy = { scanCounts: { TOP_PERC_GAIN: 50, HOT_BY_VOLUME: 50 }, failedSymbols: [], universeSize: 80 };

  it("is undefined when every scan returned rows and every symbol enriched", () => {
    expect(buildScreenerFailureMessage(healthy)).toBeUndefined();
  });

  it("says so when every scan came back empty", () => {
    expect(buildScreenerFailureMessage({ ...healthy, scanCounts: { A: 0, B: 0 } })).toBe("every scan returned zero rows, so the screener universe was not refreshed");
  });

  it("names the individual empty scans and the failed symbols", () => {
    expect(buildScreenerFailureMessage({ ...healthy, scanCounts: { A: 50, B: 0 }, failedSymbols: ["XYZ", "ABC"] })).toBe("scans returned zero rows: B; 2 of 80 symbols failed enrichment and kept their stored values: XYZ, ABC");
  });

  it("reports an empty universe and never contains '): '", () => {
    expect(buildScreenerFailureMessage({ scanCounts: { A: 0 }, failedSymbols: [], universeSize: 0 })).toContain("the screener universe is empty");
    expect(buildScreenerFailureMessage({ ...healthy, failedSymbols: ["A"] })).not.toContain("): ");
  });
});
