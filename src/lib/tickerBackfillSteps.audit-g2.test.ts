import { describe, expect, it } from "vitest";
import { buildInitialBackfillSteps, computeProgressPercent, deriveFinalRunStatus, markUnfinishedStepsInterrupted, scopeOfSteps, updateStep } from "./tickerBackfillSteps.js";

// Audit (G2, 2026-10-07): the pure step helpers behind restart-resume and the option-chain scope.
describe("tickerBackfillSteps (restart and scope helpers)", () => {
  it("the option-chain scope is the strike and snapshot steps, in order, and reads back as option_chain", () => {
    const steps = buildInitialBackfillSteps("option_chain");
    expect(steps.map((step) => step.key)).toEqual(["chain_warmup", "first_snapshot"]);
    expect(scopeOfSteps(steps)).toBe("option_chain");
    expect(scopeOfSteps(buildInitialBackfillSteps("full"))).toBe("full");
  });

  it("every call builds new step objects, so a run's edits never leak into the next run", () => {
    const first = buildInitialBackfillSteps("option_chain");
    first[0]!.status = "done";
    expect(buildInitialBackfillSteps("option_chain")[0]!.status).toBe("pending");
    expect(buildInitialBackfillSteps()[2]!.status).toBe("pending");
  });

  it("an interrupted run is finished at 100% and partial, whichever step it was on", () => {
    for (const scope of ["full", "option_chain"] as const) {
      const initial = buildInitialBackfillSteps(scope);
      for (const step of initial) {
        const cutOff = markUnfinishedStepsInterrupted(updateStep(initial, step.key, "running", null));
        expect(computeProgressPercent(cutOff)).toBe(100);
        expect(deriveFinalRunStatus(cutOff)).toBe("partial");
        expect(cutOff.find((candidate) => candidate.key === step.key)!.message).toBe("Interrupted by a server restart.");
      }
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

  it("the scope survives a restart: the interrupted steps of an option-chain run still read back as option_chain", () => {
    const interrupted = markUnfinishedStepsInterrupted(updateStep(buildInitialBackfillSteps("option_chain"), "chain_warmup", "running", null));
    expect(scopeOfSteps(interrupted)).toBe("option_chain");
  });
});
