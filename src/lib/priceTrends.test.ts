import { describe, expect, it } from "vitest";
import { buildTrendLabel } from "../ibkr/generateTradeAlertCandidates.js";
import { computePriceTrend } from "./priceTrends.js";
import { computeMacd, computeMovingAverages } from "./technicalIndicators.js";

// The calculation the deleted GET /price-performance/trends endpoint ran, copied
// verbatim, so the new path can never drift from it.
function legacyTrendCalculation(closes: number[]) {
  if (closes.length === 0) return { macdTrend: null, maTrend: null };
  const spotPrice = closes[closes.length - 1]!;
  return { macdTrend: computeMacd(closes), maTrend: buildTrendLabel(spotPrice, computeMovingAverages(closes)) };
}

function series(length: number, startPrice: number, dailyStep: number, wobble = 0): number[] {
  return Array.from({ length }, (_, index) => startPrice + index * dailyStep + Math.sin(index / 3) * wobble);
}

describe("computePriceTrend", () => {
  it("returns nulls for no history", () => {
    expect(computePriceTrend([])).toEqual({ macdTrend: null, maTrend: null });
  });

  it("matches the legacy /trends calculation exactly on rising, falling, choppy and short series", () => {
    const cases = [series(252, 100, 0.5), series(252, 300, -0.6), series(252, 100, 0, 5), series(252, 100, 0.2, 4), series(20, 50, 1), series(60, 80, -0.3, 2), series(1, 42, 0)];
    for (const closes of cases) expect(computePriceTrend(closes)).toEqual(legacyTrendCalculation(closes));
  });

  it("labels a steadily rising year as an uptrend and a steadily falling one as a downtrend", () => {
    expect(computePriceTrend(series(252, 100, 0.5)).maTrend).toBe("uptrend");
    expect(computePriceTrend(series(252, 300, -0.6)).maTrend).toBe("downtrend");
  });

  it("has no moving-average trend without ~99 closes of history, and does not throw", () => {
    expect(computePriceTrend(series(50, 100, 1)).maTrend).toBeNull();
  });

  it("uses the LAST close given as spot — so completed-only input means spot is the last completed close", () => {
    const completed = series(252, 100, 0.5);
    const withPartialCrashBar = [...completed, completed[completed.length - 1]! * 0.5];
    expect(computePriceTrend(completed).maTrend).toBe("uptrend");
    // A half-price partial bar would flip the label — exactly why partial bars are excluded upstream.
    expect(computePriceTrend(withPartialCrashBar).maTrend).not.toBe("uptrend");
  });
});
