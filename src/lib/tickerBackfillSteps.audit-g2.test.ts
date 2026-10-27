import { describe, expect, it } from "vitest";
import { buildInitialBackfillSteps, computeProgressPercent, deriveFinalRunStatus, markUnfinishedStepsInterrupted, updateStep } from "./tickerBackfillSteps.js";

// Audit (G2, 2026-10-07): the pure step helpers behind restart-resume.
describe("tickerBackfillSteps (restart helpers)", () => {
  it("every call builds new step objects, so a run's edits never leak into the next run", () => {
    const first = buildInitialBackfillSteps();
    first[0]!.status = "done";
    expect(buildInitialBackfillSteps()[0]!.status).toBe("pending");
  });

  it("an interrupted run is finished at 100% and partial, whichever step it was on", () => {
    const initial = buildInitialBackfillSteps();
    for (const step of initial) {
      const cutOff = markUnfinishedStepsInterrupted(updateStep(initial, step.key, "running", null));
      expect(computeProgressPercent(cutOff)).toBe(100);
      expect(deriveFinalRunStatus(cutOff)).toBe("partial");
      expect(cutOff.find((candidate) => candidate.key === step.key)!.message).toBe("Interrupted by a server restart.");
    }
  });

  it("a run still queued (nothing started) is interrupted with every step 'not started'", () => {
    const cutOff = markUnfinishedStepsInterrupted(buildInitialBackfillSteps());
    expect(cutOff.every((step) => step.status === "failed" && step.message === "Not started: the server restarted first.")).toBe(true);
  });

  it("marking twice changes nothing more, and finished steps keep their status and message", () => {
    const steps = updateStep(updateStep(buildInitialBackfillSteps(), "history", "done", "1253 daily bars"), "calendar", "skipped", "not on TradingView");
    const once = markUnfinishedStepsInterrupted(steps);
    expect(markUnfinishedStepsInterrupted(once)).toEqual(once);
    expect(once.slice(0, 2)).toEqual(steps.slice(0, 2));
  });
});
