import { describe, expect, it } from "vitest";
import { evaluateReleaseDeployGuard } from "./releaseDeployGuard.js";

const clean = { appEnvironment: "production" as const, marketSessionState: "closed" as const, isWithinPostCloseBuffer: false, inFlightOrderCount: 0 };

describe("evaluateReleaseDeployGuard", () => {
  it("has no problems and never aborts when everything is clean", () => {
    expect(evaluateReleaseDeployGuard(clean)).toEqual({ problems: [], shouldAbort: false });
    expect(evaluateReleaseDeployGuard({ ...clean, appEnvironment: "staging" })).toEqual({ problems: [], shouldAbort: false });
  });

  it("aborts production when the market is open", () => {
    const verdict = evaluateReleaseDeployGuard({ ...clean, marketSessionState: "open" });
    expect(verdict.shouldAbort).toBe(true);
    expect(verdict.problems).toEqual(["the market is currently open"]);
  });

  it("only warns (never aborts) staging with the exact same problems", () => {
    const verdict = evaluateReleaseDeployGuard({ ...clean, appEnvironment: "staging", marketSessionState: "open", inFlightOrderCount: 3 });
    expect(verdict.shouldAbort).toBe(false);
    expect(verdict.problems).toHaveLength(2);
  });

  it("aborts production on the post-close buffer alone", () => {
    expect(evaluateReleaseDeployGuard({ ...clean, isWithinPostCloseBuffer: true }).shouldAbort).toBe(true);
  });

  it("aborts production on in-flight orders alone, and names the count and statuses", () => {
    const verdict = evaluateReleaseDeployGuard({ ...clean, inFlightOrderCount: 2 });
    expect(verdict.shouldAbort).toBe(true);
    expect(verdict.problems[0]).toContain("2 order(s)");
    expect(verdict.problems[0]).toContain("confirmed/cancel_requested/partially_filled/submitted");
  });

  it("combines every problem that applies at once", () => {
    const verdict = evaluateReleaseDeployGuard({ appEnvironment: "production", marketSessionState: "open", isWithinPostCloseBuffer: false, inFlightOrderCount: 1 });
    expect(verdict.problems).toHaveLength(2);
  });

  it("never aborts development, even with every problem present", () => {
    expect(evaluateReleaseDeployGuard({ appEnvironment: "development", marketSessionState: "open", isWithinPostCloseBuffer: true, inFlightOrderCount: 5 }).shouldAbort).toBe(false);
  });
});
