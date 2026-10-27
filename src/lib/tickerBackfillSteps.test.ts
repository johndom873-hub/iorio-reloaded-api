import { describe, expect, it } from "vitest";
import { buildInitialBackfillSteps, type BackfillStep, computeProgressPercent, deriveFinalRunStatus, markUnfinishedStepsInterrupted, updateStep } from "./tickerBackfillSteps.js";

describe("tickerBackfillSteps", () => {
  it("starts with three pending steps at 0%", () => {
    const steps = buildInitialBackfillSteps();
    expect(steps.map((step) => step.key)).toEqual(["history", "calendar", "chain_warmup"]);
    expect(steps.every((step) => step.status === "pending")).toBe(true);
    expect(computeProgressPercent(steps)).toBe(0);
  });
  it("counts done, skipped and failed as finished but not running", () => {
    let steps = buildInitialBackfillSteps();
    steps = updateStep(steps, "history", "running", "fetching");
    expect(computeProgressPercent(steps)).toBe(0);
    steps = updateStep(steps, "history", "done", "1250 bars");
    expect(computeProgressPercent(steps)).toBe(33);
    steps = updateStep(steps, "calendar", "failed", "boom");
    expect(computeProgressPercent(steps)).toBe(67);
    steps = updateStep(steps, "chain_warmup", "skipped", null);
    expect(computeProgressPercent(steps)).toBe(100);
  });
  it("updateStep changes only the named step and does not mutate the input", () => {
    const steps = buildInitialBackfillSteps();
    const updated = updateStep(steps, "calendar", "done", "ok");
    expect(steps[1]?.status).toBe("pending");
    expect(updated.map((step) => step.status)).toEqual(["pending", "done", "pending"]);
  });
  it("is partial when any step failed, complete otherwise", () => {
    let steps: BackfillStep[] = buildInitialBackfillSteps().map((step) => ({ ...step, status: "done" as const }));
    expect(deriveFinalRunStatus(steps)).toBe("complete");
    steps = updateStep(steps, "history", "failed", "x");
    expect(deriveFinalRunStatus(steps)).toBe("partial");
  });
  it("an interrupted run fails its running and pending steps with the reason and keeps the finished ones", () => {
    let steps = updateStep(buildInitialBackfillSteps(), "history", "done", "1253 daily bars");
    steps = updateStep(steps, "calendar", "running", null);
    const interrupted = markUnfinishedStepsInterrupted(steps);
    expect(interrupted.map((step) => [step.status, step.message])).toEqual([
      ["done", "1253 daily bars"],
      ["failed", "Interrupted by a server restart."],
      ["failed", "Not started: the server restarted first."],
    ]);
    expect(deriveFinalRunStatus(interrupted)).toBe("partial");
  });
});
