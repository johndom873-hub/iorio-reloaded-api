import { describe, expect, it } from "vitest";
import { emptyDailyLossTrack, trackDailyLoss, type DailyLossTrack } from "./dailyLossConfirmation.js";

const at = (seconds: number) => Date.parse("2026-11-25T15:22:54Z") + seconds * 1000;

function run(readings: [number, number][], breakerPct = 10) {
  let track: DailyLossTrack = emptyDailyLossTrack;
  return readings.map(([seconds, pct]) => {
    const verdict = trackDailyLoss(track, { pct, atMs: at(seconds) }, breakerPct);
    track = verdict.track;
    return verdict;
  });
}

describe("trackDailyLoss", () => {
  it("staging 25 Nov: one reading at -13.13% between -7.37% and -7.34% is past the breaker but never trips it, and its jump is flagged both ways", () => {
    const [before, spike, after] = run([[0, -7.37], [24, -13.13], [46, -7.34]]);
    expect(before).toMatchObject({ past: false, confirmed: false, jumpedFromPct: null });
    expect(spike).toMatchObject({ past: true, confirmed: false, jumpedFromPct: -7.37 });
    expect(after).toMatchObject({ past: false, confirmed: false, jumpedFromPct: -13.13 });
    expect(after!.track.pastSinceMs).toBeNull();
  });

  it("trips once readings stay past the breaker for 15 s: not on the first, nor on a second 8 s later, on one 22 s in", () => {
    const verdicts = run([[0, -9], [10, -11], [18, -11.5], [32, -12]]);
    expect(verdicts.map((verdict) => verdict.confirmed)).toEqual([false, false, false, true]);
    expect(verdicts[3]!.track.pastSinceMs).toBe(at(10));
  });

  it("at the breaker counts as past it (as before: ok only above -breakerPct)", () => {
    expect(run([[0, -10], [20, -10]]).map((verdict) => [verdict.past, verdict.confirmed])).toEqual([[true, false], [true, true]]);
  });

  it("a reading more than 5 minutes after the last starts afresh: a past reading from before a pause does not confirm a new one", () => {
    const verdicts = run([[0, -12], [400, -12], [420, -12]]);
    expect(verdicts.map((verdict) => verdict.confirmed)).toEqual([false, false, true]);
    expect(verdicts[1]!.jumpedFromPct).toBeNull();
  });

  it("a move under 3 points is not flagged; 3 or more is", () => {
    expect(run([[0, -1], [20, -3.99]])[1]!.jumpedFromPct).toBeNull();
    expect(run([[0, -1], [20, -4]])[1]!.jumpedFromPct).toBe(-1);
  });
});
