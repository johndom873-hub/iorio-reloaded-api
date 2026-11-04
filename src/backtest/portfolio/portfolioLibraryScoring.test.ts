import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { libraryDailyReturns, type LibraryManifest } from "./portfolioLibrary.js";
import { combinedPathFigures, excessCalmarOfAverages, pairedChange, scoreChange } from "./portfolioLibraryScoring.js";

describe("a book put together from its tickers' lone runs (S1)", () => {
  it("compounds the weighted daily returns plus the cash's T-bill, over the horizon's first days", () => {
    // Two paths of 3 days; the horizon takes 2. Ticker A: +1% then −2%; B: 0% then +4%; 40% each, 20% cash at 2.52% a year.
    const a = Float64Array.from([0.01, -0.02, 0.5, 0.01, -0.02, 0.5]);
    const b = Float64Array.from([0, 0.04, 0.5, 0, 0.04, 0.5]);
    const figures = combinedPathFigures(
      [
        { returns: a, weight: 0.4 },
        { returns: b, weight: 0.4 },
      ],
      { pathCount: 2, daysPerPath: 3, horizonDays: 2, riskFreeRatePercent: 2.52, tradingDaysPerYear: 252 },
    );
    const cashDay = 0.2 * 0.0001;
    const dayOne = 1 + 0.4 * 0.01 + cashDay;
    const dayTwo = 1 + 0.4 * -0.02 + 0.4 * 0.04 + cashDay;
    expect(figures.cagr[0]).toBeCloseTo((dayOne * dayTwo) ** (252 / 2) - 1, 9);
    expect(figures.maxDrawdown[0]).toBe(0);
    expect(figures.cagr[1]).toBe(figures.cagr[0]);
  });

  it("measures the deepest fall from a peak", () => {
    const returns = Float64Array.from([0.1, -0.2, 0.05]);
    const figures = combinedPathFigures([{ returns, weight: 1 }], { pathCount: 1, daysPerPath: 3, horizonDays: 3, riskFreeRatePercent: 0, tradingDaysPerYear: 252 });
    expect(figures.maxDrawdown[0]).toBeCloseTo(-0.2, 12);
  });
});

describe("a change's scores (S2–S4)", () => {
  it("is the approved example: (9.31% − 4.03%) ÷ 24.47% = 0.2158 for the book's averages", () => {
    const book = { cagr: Float64Array.from([0.0931]), maxDrawdown: Float64Array.from([-0.2447]) };
    expect(excessCalmarOfAverages(book, 4.03)).toBeCloseTo(0.2158, 4);
  });

  it("averages the per-path differences, ± 2 standard errors", () => {
    const change = pairedChange(Float64Array.from([0.11, 0.12, 0.13, 0.14]), Float64Array.from([0.1, 0.1, 0.1, 0.1]));
    expect(change.change).toBeCloseTo(0.025, 12);
    // Differences 0.01..0.04: standard deviation 0.0129099; ÷ √4 × 2.
    expect(change.plusMinus).toBeCloseTo(0.0129099, 6);
  });

  it("marks a change within noise when its score is within its ±, and not when every path gains", () => {
    const paths = 200;
    const book = { cagr: Float64Array.from({ length: paths }, (_, at) => 0.08 + ((at * 37) % 11) / 100), maxDrawdown: Float64Array.from({ length: paths }, (_, at) => -0.2 - ((at * 13) % 7) / 100) };
    const same = scoreChange(book, book, 4, 1);
    expect(same.score.change).toBe(0);
    expect(same.withinNoise).toBe(true);
    const better = scoreChange({ cagr: book.cagr.map((value) => value + 0.02), maxDrawdown: book.maxDrawdown }, book, 4, 1);
    expect(better.cagr.change).toBeCloseTo(0.02, 12);
    expect(better.cagr.plusMinus).toBeCloseTo(0, 12);
    expect(better.score.change).toBeGreaterThan(0);
    expect(better.withinNoise).toBe(false);
  });
});

describe("a ticker's daily returns at a pot between two levels (L2)", () => {
  it("blends the two levels' daily returns by where ln(pot) falls, and takes the end level outside them", () => {
    const dataDirectory = mkdtempSync(path.join(tmpdir(), "portfolio-library-"));
    try {
      mkdirSync(path.join(dataDirectory, "portfolio-library", "TEST"), { recursive: true });
      // One path of 2 days at each level: $40k +1% then +1%; $65k +3% then −1%; $25k and the others flat.
      const write = (pot: number, values: number[]) => writeFileSync(path.join(dataDirectory, "portfolio-library", "TEST", `${pot}.f32`), Buffer.from(Float32Array.from(values).buffer));
      for (const pot of [25_000, 100_000, 160_000, 250_000]) write(pot, [1, 1]);
      write(40_000, [1.01, 1.0201]);
      write(65_000, [1.03, 1.0197]);
      const manifest = { pathCount: 1, horizonDays: 2, potLevelsDollars: [25_000, 40_000, 65_000, 100_000, 160_000, 250_000] } as LibraryManifest;
      // $50k: ln(50/40) ÷ ln(65/40) = 0.4596 of the way to $65k.
      const weight = Math.log(50 / 40) / Math.log(65 / 40);
      const blended = libraryDailyReturns(manifest, "TEST", 50_000, dataDirectory);
      expect(blended[0]).toBeCloseTo((1 - weight) * 0.01 + weight * 0.03, 6);
      expect(blended[1]).toBeCloseTo((1 - weight) * 0.01 + weight * (1.0197 / 1.03 - 1), 6);
      expect(libraryDailyReturns(manifest, "TEST", 40_000, dataDirectory)[0]).toBeCloseTo(0.01, 6);
      expect(libraryDailyReturns(manifest, "TEST", 10_000, dataDirectory)[0]).toBe(0);
      expect(libraryDailyReturns(manifest, "TEST", 900_000, dataDirectory)[0]).toBe(0);
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});
