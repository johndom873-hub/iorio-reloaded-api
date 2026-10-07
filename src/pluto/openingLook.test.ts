import { describe, expect, it } from "vitest";
import { advanceOpeningLook, decideOpeningLook, openingLookFallbackEtMinutes, type OpeningLookProgress } from "./openingLook.js";

const today = "2026-10-07";
const fresh: OpeningLookProgress = { doneFor: null, incompleteFor: null };
const at = (hour: number, minute: number) => hour * 60 + minute;

describe("decideOpeningLook", () => {
  it("waits while the seed is running, before 10:30 ET", () => {
    expect(decideOpeningLook({ todayIso: today, nowEtMinutes: at(10, 2), seedFinished: false, progress: fresh })).toBe("wait");
    expect(decideOpeningLook({ todayIso: today, nowEtMinutes: openingLookFallbackEtMinutes - 1, seedFinished: false, progress: fresh })).toBe("wait");
  });

  it("runs the complete look as soon as the seed has finished", () => {
    expect(decideOpeningLook({ todayIso: today, nowEtMinutes: at(10, 7), seedFinished: true, progress: fresh })).toBe("run_complete");
  });

  it("runs on incomplete data at 10:30 ET, then once more when the seed lands", () => {
    const first = decideOpeningLook({ todayIso: today, nowEtMinutes: at(10, 30), seedFinished: false, progress: fresh });
    expect(first).toBe("run_incomplete");
    const afterFirst = advanceOpeningLook(fresh, today, first);
    expect(decideOpeningLook({ todayIso: today, nowEtMinutes: at(10, 35), seedFinished: false, progress: afterFirst })).toBe("done");
    const second = decideOpeningLook({ todayIso: today, nowEtMinutes: at(11, 5), seedFinished: true, progress: afterFirst });
    expect(second).toBe("run_after_late_seed");
    const afterSecond = advanceOpeningLook(afterFirst, today, second);
    expect(decideOpeningLook({ todayIso: today, nowEtMinutes: at(11, 6), seedFinished: true, progress: afterSecond })).toBe("done");
  });

  it("runs once a day: a complete look owes no late-seed round", () => {
    const after = advanceOpeningLook(fresh, today, "run_complete");
    expect(decideOpeningLook({ todayIso: today, nowEtMinutes: at(12, 0), seedFinished: true, progress: after })).toBe("done");
  });

  it("starts over on a new trading day", () => {
    const yesterday = advanceOpeningLook(fresh, "2026-10-06", "run_incomplete");
    expect(decideOpeningLook({ todayIso: today, nowEtMinutes: at(10, 1), seedFinished: false, progress: yesterday })).toBe("wait");
    expect(decideOpeningLook({ todayIso: today, nowEtMinutes: at(10, 8), seedFinished: true, progress: yesterday })).toBe("run_complete");
  });
});
