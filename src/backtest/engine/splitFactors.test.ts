import { describe, expect, it } from "vitest";
import { inferSplitSchedule, niceSplitFactors, requireSplitFactors, snapToNiceSplitFactor, splitFactorOn, UnresolvedSplitScaleError, type DailySplitRatio } from "./splitFactors.js";
import { weekdaysBetween } from "./testSupport/syntheticBacktestData.js";

/** Ratios on consecutive weekdays from 2026-01-05, with ±1.5% deterministic noise unless given exactly. */
function ratioDays(values: (number | null)[], noise = true): DailySplitRatio[] {
  const dates = weekdaysBetween("2026-01-05", "2026-12-31");
  return values.map((value, index) => ({ dateIso: dates[index]!, ratio: value === null ? null : value * (noise ? 1 + 0.015 * Math.sin(index * 2.3) : 1) }));
}
const repeat = (value: number | null, count: number) => Array<number | null>(count).fill(value);

describe("snapToNiceSplitFactor", () => {
  it("snaps within ±3% to the factor made of the fewest standard splits", () => {
    expect(snapToNiceSplitFactor(1.02)).toBe(1);
    expect(snapToNiceSplitFactor(9.89)).toBe(10);
    expect(snapToNiceSplitFactor(10.25)).toBe(10);
    expect(snapToNiceSplitFactor(39.2)).toBe(40);
    expect(snapToNiceSplitFactor(0.101)).toBe(0.1);
    expect(snapToNiceSplitFactor(1.52)).toBe(1.5);
  });

  it("leaves a ratio no standard factor explains unsnapped (forward and reverse splits are not mixed in one factor)", () => {
    expect(snapToNiceSplitFactor(1.4)).toBeNull();
    expect(snapToNiceSplitFactor(1.17)).toBeNull();
    expect(snapToNiceSplitFactor(0.7)).toBeNull();
    expect(niceSplitFactors.some((entry) => Math.abs(entry.factor - 9.8) < 1e-9)).toBe(false);
  });
});

describe("inferSplitSchedule", () => {
  it("finds a 10-for-1 split as one change point", () => {
    const days = ratioDays([...repeat(10, 12), ...repeat(1, 10)]);
    const schedule = inferSplitSchedule(days);
    expect(schedule.unresolved).toEqual([]);
    expect(schedule.splits).toEqual([{ lastDayBefore: days[11]!.dateIso, firstDayAfter: days[12]!.dateIso, ratio: 10 }]);
    expect(splitFactorOn(schedule, days[0]!.dateIso)).toBe(10);
    expect(splitFactorOn(schedule, days[21]!.dateIso)).toBe(1);
  });

  it("finds a 4-for-1 and then a 10-for-1 split: cumulative 40, then 10, then 1", () => {
    const days = ratioDays([...repeat(40, 8), ...repeat(10, 7), ...repeat(1, 9)]);
    const schedule = inferSplitSchedule(days);
    expect(schedule.segments.map((segment) => segment.factor)).toEqual([40, 10, 1]);
    expect(schedule.splits.map((split) => [split.lastDayBefore, split.firstDayAfter, split.ratio])).toEqual([
      [days[7]!.dateIso, days[8]!.dateIso, 4],
      [days[14]!.dateIso, days[15]!.dateIso, 10],
    ]);
  });

  it("finds a 1-for-10 reverse split", () => {
    const days = ratioDays([...repeat(0.1, 9), ...repeat(1, 9)]);
    expect(inferSplitSchedule(days).splits).toEqual([{ lastDayBefore: days[8]!.dateIso, firstDayAfter: days[9]!.dateIso, ratio: 0.1 }]);
  });

  it("does not read one noisy +40% day as a 3-for-2 split", () => {
    const values = repeat(1, 20);
    values[9] = 1.4;
    const schedule = inferSplitSchedule(ratioDays(values));
    expect(schedule.splits).toEqual([]);
    expect(schedule.segments).toHaveLength(1);
    expect(schedule.segments[0]!.factor).toBe(1);
  });

  it("gives days with no ratio the surrounding factor", () => {
    const days = ratioDays([...repeat(10, 6), null, null, ...repeat(10, 6)]);
    const schedule = inferSplitSchedule(days);
    expect(splitFactorOn(schedule, days[6]!.dateIso)).toBe(10);
    expect(schedule.unresolved).toEqual([]);
  });

  it("puts the change point where the gap's own ratios fit, when noise hides it from the medians", () => {
    // 2 days just after the split read high (stale closing quotes): medians flip late, the misfit rule finds the split.
    const days = ratioDays([...repeat(2, 8), 1.3, 1.25, ...repeat(1, 8)], false);
    const schedule = inferSplitSchedule(days);
    expect(schedule.unresolved).toEqual([]);
    expect(schedule.splits).toEqual([{ lastDayBefore: days[7]!.dateIso, firstDayAfter: days[8]!.dateIso, ratio: 2 }]);
  });

  it("leaves a stretch no standard factor holds for unresolved, and a session over it fails naming the dates and ratios", () => {
    const days = ratioDays([...repeat(1, 8), ...repeat(1.17, 6), ...repeat(1, 8)], false);
    const schedule = inferSplitSchedule(days);
    expect(schedule.splits).toEqual([]);
    expect(schedule.unresolved.length).toBeGreaterThan(0);
    const stretch = schedule.unresolved[0]!;
    expect(stretch.ratios.every((day) => day.ratio === 1.17 || day.ratio === 1)).toBe(true);
    expect(() => requireSplitFactors("XYZ", schedule, [days[10]!.dateIso])).toThrow(UnresolvedSplitScaleError);
    expect(() => requireSplitFactors("XYZ", schedule, [days[10]!.dateIso])).toThrow(/XYZ price scale cannot be inferred for .* 1\.170/);
    // Days outside the stretch are fine.
    expect(requireSplitFactors("XYZ", schedule, [days[0]!.dateIso]).get(days[0]!.dateIso)).toBe(1);
  });

  it("gives a noisy stretch between two runs of the same factor that factor, when its median is nearest it (AAOI 2022-03-21 to 03-25)", () => {
    // AAOI's real ratios 2022-03-01 to 2022-04-14 (a $3 stock, no split): 2022-03-15 to 03-25 formed no run.
    const aaoiRatios = [
      0.984, 0.9999, 1.0069, 1.0043, 1.0111, 0.9986, 0.9744, 0.9999, 1.0072, 1.0099, 0.3582, 1.2194, null, 0.9417, 0.9832, 1.0376, 1.0626, 1.0488, 1.0853, 1.0028, 0.9354, 0.9597, 0.9862, 1.027,
      0.9749, null, 1.0232, null, 0.814, 1.0498, 0.9074, 1.723, null,
    ];
    const days = ratioDays(aaoiRatios, false);
    const schedule = inferSplitSchedule(days);
    expect(schedule.unresolved).toEqual([]);
    expect(schedule.splits).toEqual([]);
    expect(schedule.segments).toEqual([{ fromDateIso: days[0]!.dateIso, toDateIso: days.at(-1)!.dateIso, factor: 1 }]);
  });

  it("keeps such a stretch unresolved when it is longer than 30 file days", () => {
    const alternating = (count: number) => Array.from({ length: count }, (_, index) => (index % 2 === 0 ? 1.06 : 0.94));
    // The window medians next to the runs take two days at each end of the stretch: the gap is the stretch less 4 days.
    expect(inferSplitSchedule(ratioDays([...repeat(1, 10), ...alternating(20), ...repeat(1, 10)], false)).unresolved).toEqual([]);
    const tooLong = inferSplitSchedule(ratioDays([...repeat(1, 10), ...alternating(40), ...repeat(1, 10)], false));
    expect(tooLong.unresolved.length).toBe(1);
    expect(tooLong.unresolved[0]!.ratios.length).toBe(36);
    expect(tooLong.unresolved[0]!.ratios.every((day) => day.ratio === 1.06 || day.ratio === 0.94)).toBe(true);
  });

  it("does not confirm a new factor seen on fewer than 5 days at the end of the file", () => {
    const days = ratioDays([...repeat(1, 10), ...repeat(2, 3)], false);
    const schedule = inferSplitSchedule(days);
    expect(schedule.splits).toEqual([]);
    expect(schedule.unresolved.map((stretch) => [stretch.fromDateIso, stretch.toDateIso])).toEqual([[days[10]!.dateIso, days[12]!.dateIso]]);
  });

  it("settles a short file from all its days", () => {
    const schedule = inferSplitSchedule(ratioDays([10.1, 9.9, null]));
    expect(schedule.segments).toEqual([{ fromDateIso: "2026-01-05", toDateIso: "2026-01-07", factor: 10 }]);
  });
});
