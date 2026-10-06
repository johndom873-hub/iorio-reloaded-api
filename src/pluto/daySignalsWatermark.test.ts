import { describe, expect, it } from "vitest";
import { contractKey, findNewlyQuotedContracts, rememberAnalysed, type DaySignalQuoteStamp } from "./daySignalsWatermark.js";

const stamp = (symbol: string, strike: number, quotedAtMs: number, right = "P"): DaySignalQuoteStamp => ({ symbol, expiry: "2026-10-17", strike, right, quotedAtMs });

describe("findNewlyQuotedContracts", () => {
  it("treats every contract as new the first time", () => {
    const result = findNewlyQuotedContracts([stamp("HOOD", 24, 1000), stamp("HOOD", 25, 1000), stamp("MU", 100, 1000)], new Map());
    expect(result).toMatchObject({ symbols: ["HOOD", "MU"], contractCount: 3 });
  });

  it("never returns a contract whose quote was already analysed, and tracks each contract's own timestamp", () => {
    const seen = new Map<string, number>();
    rememberAnalysed([stamp("HOOD", 24, 1000), stamp("HOOD", 25, 1000), stamp("MU", 100, 1000)], seen);
    const result = findNewlyQuotedContracts([stamp("HOOD", 24, 1000), stamp("HOOD", 25, 2000), stamp("MU", 100, 1000)], seen);
    expect(result.symbols).toEqual(["HOOD"]);
    expect(result.stamps).toEqual([stamp("HOOD", 25, 2000)]);
    expect(findNewlyQuotedContracts([stamp("HOOD", 24, 1000), stamp("MU", 100, 1000)], seen).contractCount).toBe(0);
  });

  it("a put and a call at the same strike are separate quotes", () => {
    expect(contractKey(stamp("HOOD", 24, 1, "P"))).not.toBe(contractKey(stamp("HOOD", 24, 1, "C")));
  });
});
