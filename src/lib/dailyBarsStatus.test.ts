import { describe, expect, it } from "vitest";
import { planDailyBarsPopulation } from "./dailyBarsStatus.js";

describe("planDailyBarsPopulation", () => {
  const lastCompletedSessionDateIso = "2026-09-30";

  it("fetches the full history when there are no bars", () => {
    expect(planDailyBarsPopulation({ historyIncomplete: false, latestBarDateIso: null, lastCompletedSessionDateIso })).toBe("full");
  });

  it("fetches the full history when it is incomplete, even if the newest bar is current", () => {
    expect(planDailyBarsPopulation({ historyIncomplete: true, latestBarDateIso: "2026-09-30", lastCompletedSessionDateIso })).toBe("full");
  });

  it("tops up when history is complete but the newest bar is behind the last completed session", () => {
    expect(planDailyBarsPopulation({ historyIncomplete: false, latestBarDateIso: "2026-09-29", lastCompletedSessionDateIso })).toBe("topUp");
  });

  it("does nothing when the newest bar is the last completed session", () => {
    expect(planDailyBarsPopulation({ historyIncomplete: false, latestBarDateIso: "2026-09-30", lastCompletedSessionDateIso })).toBe("none");
  });

  it("does nothing when the newest bar is ahead of the last completed session (a live bar for today)", () => {
    expect(planDailyBarsPopulation({ historyIncomplete: false, latestBarDateIso: "2026-10-01", lastCompletedSessionDateIso })).toBe("none");
  });
});
