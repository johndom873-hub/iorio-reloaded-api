import { describe, expect, it } from "vitest";
import { addCalendarDays, buildSignalsRoadmap, buildTickerCaveats, projectTradingDays, tradingDaysForMomentum, tradingDaysForOwnVolatilityThreshold, type RoadmapCounts } from "./signalsRoadmap.js";

const today = "2026-09-22";
const counts: RoadmapCounts = { signalsOrderFills: 0, spreadCostChargedPct: 50 };

describe("projectTradingDays", () => {
  it("adds 7 calendar days per 5 trading days, rounded up, never negative", () => {
    expect(projectTradingDays(today, 5)).toBe("2026-09-29");
    expect(projectTradingDays(today, 1)).toBe(addCalendarDays(today, 2)); // ceil(1.4)
    expect(projectTradingDays(today, 0)).toBe(today);
    expect(projectTradingDays(today, -10)).toBe(today);
  });
  it("addCalendarDays crosses month and year ends", () => {
    expect(addCalendarDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});

describe("buildSignalsRoadmap", () => {
  const items = buildSignalsRoadmap(counts);
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  it("lists the open items in order", () => {
    expect(items.map((item) => item.id)).toEqual(["blend", "ratio", "earnings", "friction", "sizing"]);
  });

  it("no longer lists skew or SVI stability: the model review settled both", () => {
    expect(byId.skew).toBeUndefined();
    expect(byId.svi).toBeUndefined();
  });

  it("earnings waits on a decision, the backtest-bound items on the ThetaData backtests", () => {
    expect(byId.earnings!.status).toBe("waiting_on_decision");
    for (const id of ["blend", "ratio", "sizing"]) {
      expect(byId[id]!.status).toBe("waiting_on_data");
      expect(byId[id]!.eta).toEqual({ kind: "text", text: "After the ThetaData backtests" });
    }
  });

  it("friction names the spread cost setting in force", () => {
    expect(byId.friction!.title).toBe("Friction charges 50% of the half-spread (λ = 0.50)");
    expect(buildSignalsRoadmap({ ...counts, spreadCostChargedPct: 100 }).find((item) => item.id === "friction")!.title).toBe("Friction charges 100% of the half-spread (λ = 1.00)");
  });

  it("no longer lists the split-guard item: splits are detected when prices are stored", () => {
    expect(byId.splits).toBeUndefined();
  });

  it("no longer lists the dividend-schedule item: the decision was made and the cadence projection was built", () => {
    expect(byId.dividends).toBeUndefined();
  });

  it("friction says counting has not started while there are no Signals fills, then counts down", () => {
    expect(byId.friction!.eta).toMatchObject({ kind: "text", text: expect.stringContaining("No filled Signals orders yet"), progress: { have: 0, need: 50 } });
    const later = buildSignalsRoadmap({ ...counts, signalsOrderFills: 12 }).find((item) => item.id === "friction")!;
    expect(later.eta).toMatchObject({ kind: "text", text: "38 more fills", progress: { have: 12 } });
  });
});

describe("buildTickerCaveats", () => {
  it("is empty for a scored ticker with full history and no dividends", () => {
    expect(buildTickerCaveats({ unscoredReason: null, dailyBarCount: 1253, dividendCadenceUnknown: false, snapshotDateIso: today }, today)).toEqual([]);
  });
  it("flags a missing snapshot, a short history (momentum first, then the own threshold) and dividends", () => {
    const caveats = buildTickerCaveats({ unscoredReason: "no_snapshot", dailyBarCount: 118, dividendCadenceUnknown: true, snapshotDateIso: null }, today);
    expect(caveats.map((caveat) => caveat.id)).toEqual(["no_snapshot", "short_history", "dividend_payer"]);
    expect(caveats[1]!.title).toBe(`Momentum unavailable: 118 of ${tradingDaysForMomentum} daily bars`);
    expect(caveats[1]!.eta).toEqual({ kind: "date", dateIso: projectTradingDays(today, tradingDaysForMomentum - 118), progress: { have: 118, need: tradingDaysForMomentum, unit: "daily bars" } });

    const [thresholdOnly] = buildTickerCaveats({ unscoredReason: null, dailyBarCount: 300, dividendCadenceUnknown: false, snapshotDateIso: today }, today);
    expect(thresholdOnly!.title).toContain(`300 of ${tradingDaysForOwnVolatilityThreshold}`);
    expect(thresholdOnly!.eta).toMatchObject({ dateIso: projectTradingDays(today, tradingDaysForOwnVolatilityThreshold - 300) });
  });
  it("a one-year backfill (252 bars) points at Backfill history rather than waiting", () => {
    const [caveat] = buildTickerCaveats({ unscoredReason: null, dailyBarCount: 252, dividendCadenceUnknown: false, snapshotDateIso: today }, today);
    expect(caveat!.needs).toContain("Backfill history");
  });
  it("flags a stale surface when the snapshot wasn't captured today, ahead of the history caveats", () => {
    const caveats = buildTickerCaveats({ unscoredReason: null, dailyBarCount: 1253, dividendCadenceUnknown: false, snapshotDateIso: "2026-09-21" }, today);
    expect(caveats.map((caveat) => caveat.id)).toEqual(["stale_surface"]);
    expect(caveats[0]!.title).toBe("Scored on a stale surface: 2026-09-21");
    expect(caveats[0]!.status).toBe("waiting_on_next_run");
    expect(caveats[0]!.eta).toEqual({ kind: "text", text: "Next capture" });
  });
  it("does not flag a stale surface when there is no snapshot at all (already covered by no_snapshot)", () => {
    const caveats = buildTickerCaveats({ unscoredReason: "no_snapshot", dailyBarCount: 1253, dividendCadenceUnknown: false, snapshotDateIso: null }, today);
    expect(caveats.map((caveat) => caveat.id)).toEqual(["no_snapshot"]);
  });
});
