import { describe, expect, it } from "vitest";
import { addCalendarDays, buildSignalsRoadmap, buildTickerCaveats, nightsForBlending, nightsForSkewValidation, nightsForSviStability, projectTradingDays, tradingDaysForMomentum, tradingDaysForOwnVolatilityThreshold, type RoadmapCounts } from "./signalsRoadmap.js";

const today = "2026-09-22";
const counts: RoadmapCounts = { snapshotNights: 1, fittedNights: 1, minimumPastEarningsPerTicker: 1, signalsOrderFills: 0 };

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
  const items = buildSignalsRoadmap(counts, today);
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  it("projects data-bound ETAs from the counts (independent arithmetic)", () => {
    expect(byId.blend!.eta).toEqual({ kind: "date", dateIso: addCalendarDays(today, Math.ceil((nightsForBlending - 1) * 1.4)), progress: { have: 1, need: nightsForBlending, unit: "nightly chains" } });
    expect(byId.svi!.eta).toEqual({ kind: "date", dateIso: addCalendarDays(today, Math.ceil((nightsForSviStability - 1) * 1.4)), progress: { have: 1, need: nightsForSviStability, unit: "nightly fits" } });
    expect(byId.skew!.eta).toEqual({ kind: "date", dateIso: addCalendarDays(today, Math.ceil((nightsForSkewValidation - 1) * 1.4)), progress: { have: 1, need: nightsForSkewValidation, unit: "nightly chains" } });
    expect(byId.earnings!.eta).toEqual({ kind: "date", dateIso: addCalendarDays(today, 3 * 91), progress: { have: 1, need: 4, unit: expect.any(String) } });
  });

  it("caps progress at the target once the data exists and the ETA is today", () => {
    const done = buildSignalsRoadmap({ ...counts, snapshotNights: 500, fittedNights: 500, minimumPastEarningsPerTicker: 9 }, today);
    const doneById = Object.fromEntries(done.map((item) => [item.id, item]));
    expect(doneById.blend!.eta).toMatchObject({ dateIso: today, progress: { have: nightsForBlending } });
    expect(doneById.earnings!.eta).toMatchObject({ dateIso: today, progress: { have: 4 } });
  });

  it("keeps decision / build / later-phase items as text", () => {
    expect(byId.ratio!.status).toBe("waiting_on_build");
    expect(byId.ratio!.eta.kind).toBe("text");
    expect(byId.sizing!.status).toBe("waiting_on_later_phase");
  });

  it("no longer lists the split-guard item: suspected splits are a per-ticker caveat now", () => {
    expect(byId.splits).toBeUndefined();
  });

  it("no longer lists the dividend-schedule item: the decision was made and the cadence projection was built", () => {
    expect(byId.dividends).toBeUndefined();
  });

  it("friction says counting has not started while there are no Signals fills, then counts down", () => {
    expect(byId.friction!.eta).toMatchObject({ kind: "text", text: expect.stringContaining("No filled Signals orders yet"), progress: { have: 0, need: 50 } });
    const later = buildSignalsRoadmap({ ...counts, signalsOrderFills: 12 }, today).find((item) => item.id === "friction")!;
    expect(later.eta).toMatchObject({ kind: "text", text: "38 more fills", progress: { have: 12 } });
  });
});

describe("buildTickerCaveats", () => {
  it("is empty for a scored ticker with full history and no dividends", () => {
    expect(buildTickerCaveats({ unscoredReason: null, suspectedSplitDateIso: null, dailyBarCount: 1253, dividendCadenceUnknown: false }, today)).toEqual([]);
  });
  it("flags a missing snapshot, a short history (momentum first, then the own threshold) and dividends", () => {
    const caveats = buildTickerCaveats({ unscoredReason: "no_snapshot", suspectedSplitDateIso: null, dailyBarCount: 118, dividendCadenceUnknown: true }, today);
    expect(caveats.map((caveat) => caveat.id)).toEqual(["no_snapshot", "short_history", "dividend_payer"]);
    expect(caveats[1]!.title).toBe(`Momentum unavailable: 118 of ${tradingDaysForMomentum} daily bars`);
    expect(caveats[1]!.eta).toEqual({ kind: "date", dateIso: projectTradingDays(today, tradingDaysForMomentum - 118), progress: { have: 118, need: tradingDaysForMomentum, unit: "daily bars" } });

    const [thresholdOnly] = buildTickerCaveats({ unscoredReason: null, suspectedSplitDateIso: null, dailyBarCount: 300, dividendCadenceUnknown: false }, today);
    expect(thresholdOnly!.title).toContain(`300 of ${tradingDaysForOwnVolatilityThreshold}`);
    expect(thresholdOnly!.eta).toMatchObject({ dateIso: projectTradingDays(today, tradingDaysForOwnVolatilityThreshold - 300) });
  });
  it("a suspected split names the flagged day and points at Backfill history, ahead of the history caveats", () => {
    const caveats = buildTickerCaveats({ unscoredReason: "suspected_split", suspectedSplitDateIso: "2026-09-15", dailyBarCount: 118, dividendCadenceUnknown: false }, today);
    expect(caveats.map((caveat) => caveat.id)).toEqual(["suspected_split", "short_history"]);
    expect(caveats[0]!.title).toContain("2026-09-15");
    expect(caveats[0]!.needs).toContain("Backfill history");
    expect(caveats[0]!.status).toBe("waiting_on_data");
  });
  it("a one-year backfill (252 bars) points at Backfill history rather than waiting", () => {
    const [caveat] = buildTickerCaveats({ unscoredReason: null, suspectedSplitDateIso: null, dailyBarCount: 252, dividendCadenceUnknown: false }, today);
    expect(caveat!.needs).toContain("Backfill history");
  });
});
