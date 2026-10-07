import { describe, expect, it } from "vitest";
import { buildScreenerFailureMessage, describeFailedEnrichment, isEmptyEnrichment, type EnrichmentQuote } from "./screenerScanOutcome.js";

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

  it("is still true when the only thing that came back is an IBKR error", () => {
    expect(isEmptyEnrichment({ ...quote(), ibkrError: { code: 200, message: "No security definition has been found for the request" } } as EnrichmentQuote)).toBe(true);
  });
});

describe("describeFailedEnrichment", () => {
  it("names the IBKR error code and message", () => {
    expect(describeFailedEnrichment("PSKY", { code: 200, message: "No security definition has been found for the request" })).toBe("PSKY (IBKR 200 No security definition has been found for the request)");
  });

  it("says it timed out when IBKR sent no error", () => {
    expect(describeFailedEnrichment("XYZ", null)).toBe("XYZ (no data before the timeout)");
  });

  it("never lets an IBKR message put '): ' into the alert", () => {
    expect(describeFailedEnrichment("XYZ", { code: 354, message: "Requested market data is not subscribed (NYSE): delayed" })).not.toContain("): ");
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
