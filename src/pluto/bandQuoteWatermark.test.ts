import { describe, expect, it } from "vitest";
import { findNewlyFinishedBandCycles, rememberAnalysed, type FinishedBandCycleStamp } from "./bandQuoteWatermark.js";

const stamp = (symbol: string, finishedAtMs: number): FinishedBandCycleStamp => ({ symbol, finishedAtMs });

describe("findNewlyFinishedBandCycles", () => {
  it("treats every ticker's finished cycle as new the first time", () => {
    const result = findNewlyFinishedBandCycles([stamp("MU", 1000), stamp("HOOD", 1000)], new Map());
    expect(result).toEqual({ symbols: ["HOOD", "MU"], stamps: [stamp("MU", 1000), stamp("HOOD", 1000)] });
  });

  it("analyses a ticker again only once a newer cycle has finished on it", () => {
    const seen = new Map<string, number>();
    rememberAnalysed([stamp("HOOD", 1000), stamp("MU", 1000)], seen);
    const result = findNewlyFinishedBandCycles([stamp("HOOD", 2000), stamp("MU", 1000)], seen);
    expect(result).toEqual({ symbols: ["HOOD"], stamps: [stamp("HOOD", 2000)] });
    expect(findNewlyFinishedBandCycles([stamp("HOOD", 1000), stamp("MU", 1000)], seen).symbols).toEqual([]);
  });
});
