import { describe, expect, it } from "vitest";
import { findFlexAccountProblem } from "./flexStatementAccountGuard.js";
import { workerHeartbeatAlertAfterMs } from "./workerHeartbeatLiveness.js";

const now = new Date("2026-10-02T22:30:00Z");
const beatAgo = (ms: number) => new Date(now.getTime() - ms);
const valid = { statementAccountIds: ["U21518308"], workerAccountIds: ["U21518308"], workerHeartbeatAt: beatAgo(30_000), now };

describe("findFlexAccountProblem", () => {
  it("accepts a report for the account the worker is bound to", () => {
    expect(findFlexAccountProblem(valid)).toBeNull();
  });

  it("accepts a heartbeat exactly at the staleness limit", () => {
    expect(findFlexAccountProblem({ ...valid, workerHeartbeatAt: beatAgo(workerHeartbeatAlertAfterMs) })).toBeNull();
  });

  it("refuses a paper-account report in a live environment, naming both accounts", () => {
    const problem = findFlexAccountProblem({ ...valid, statementAccountIds: ["DUR854038"] });
    expect(problem).toContain("DUR854038");
    expect(problem).toContain("U21518308");
    expect(problem).toContain("different account");
  });

  it("refuses a report that covers several accounts or none", () => {
    expect(findFlexAccountProblem({ ...valid, statementAccountIds: ["U21518308", "U99999999"] })).toContain("2 statements");
    expect(findFlexAccountProblem({ ...valid, statementAccountIds: [] })).toContain("0 statements");
  });

  it("refuses a report that does not name its account", () => {
    expect(findFlexAccountProblem({ ...valid, statementAccountIds: [undefined] })).toContain("does not say which account");
    expect(findFlexAccountProblem({ ...valid, statementAccountIds: [""] })).toContain("does not say which account");
  });

  it("fails closed when the worker's account cannot be read: no heartbeat row, a stale heartbeat, or no accounts", () => {
    expect(findFlexAccountProblem({ ...valid, workerHeartbeatAt: null, workerAccountIds: null })).toContain("never reported");
    expect(findFlexAccountProblem({ ...valid, workerHeartbeatAt: beatAgo(workerHeartbeatAlertAfterMs + 1) })).toContain("stale");
    expect(findFlexAccountProblem({ ...valid, workerAccountIds: null })).toContain("reports no account");
    expect(findFlexAccountProblem({ ...valid, workerAccountIds: [] })).toContain("reports no account");
  });

  it("keeps the message identical however old a stale heartbeat is (the alert is re-sent when its text changes)", () => {
    const fiveMinutesTooOld = findFlexAccountProblem({ ...valid, workerHeartbeatAt: beatAgo(workerHeartbeatAlertAfterMs + 60_000) });
    const aDayTooOld = findFlexAccountProblem({ ...valid, workerHeartbeatAt: beatAgo(24 * 60 * 60_000) });
    expect(fiveMinutesTooOld).toBe(aDayTooOld);
  });
});
