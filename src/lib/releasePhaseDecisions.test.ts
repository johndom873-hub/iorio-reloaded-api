import { describe, expect, it } from "vitest";
import { decideRestoreAfterFailedRelease, parseWorkerDeployResult, readInjectedReleaseFailure, workerStateAfterSshError } from "./releasePhaseDecisions.js";

describe("parseWorkerDeployResult", () => {
  it("reads a deploy and the commit the worker now runs", () => {
    const result = parseWorkerDeployResult("--- building ---\nDEPLOY_RESULT=deployed PREVIOUS=aaa111 CURRENT=bbb222\nDeployed aaa111 -> bbb222.\n");
    expect(result).toEqual({ kind: "deployed", detail: "PREVIOUS=aaa111 CURRENT=bbb222", runningCommit: "bbb222" });
  });

  it("reads an already-current worker", () => {
    expect(parseWorkerDeployResult("DEPLOY_RESULT=skipped_no_new_commit CURRENT=ccc333\n")).toEqual({ kind: "skipped_no_new_commit", detail: "CURRENT=ccc333", runningCommit: "ccc333" });
  });

  it("reads a rollback without treating its CURRENT as a deployed commit", () => {
    const result = parseWorkerDeployResult("DEPLOY_RESULT=rolled_back FAILED_COMMIT=ddd444 CURRENT=aaa111 FAILED_BUILD_KEPT_AT=/opt/x\n");
    expect(result.kind).toBe("rolled_back");
    expect(result.runningCommit).toBeNull();
  });

  it("treats output without a result line as unparseable", () => {
    expect(parseWorkerDeployResult("npm ERR! something\n")).toEqual({ kind: "unparseable", detail: "", runningCommit: null });
  });
});

describe("workerStateAfterSshError", () => {
  const timeoutMessage = "Timed out waiting for the worker deploy to finish on the VPS.";

  it("counts a refused or unresolvable connection as untouched", () => {
    expect(workerStateAfterSshError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), timeoutMessage)).toBe("untouched");
    expect(workerStateAfterSshError(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }), timeoutMessage)).toBe("untouched");
  });

  it("counts a failed handshake or login as untouched", () => {
    expect(workerStateAfterSshError(new Error("Timed out while waiting for handshake"), timeoutMessage)).toBe("untouched");
    expect(workerStateAfterSshError(Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" }), timeoutMessage)).toBe("untouched");
  });

  it("counts our own timeout and a mid-session reset as unknown", () => {
    expect(workerStateAfterSshError(new Error(timeoutMessage), timeoutMessage)).toBe("unknown");
    expect(workerStateAfterSshError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), timeoutMessage)).toBe("unknown");
    expect(workerStateAfterSshError("not an error", timeoutMessage)).toBe("unknown");
  });
});

describe("decideRestoreAfterFailedRelease", () => {
  it("restores when the worker runs the previous code and nothing was traded since the backup", () => {
    expect(decideRestoreAfterFailedRelease({ workerState: "untouched", tradingRowsWrittenSinceBackup: 0 })).toEqual({ restore: true });
    expect(decideRestoreAfterFailedRelease({ workerState: "reverted", tradingRowsWrittenSinceBackup: 0 })).toEqual({ restore: true });
  });

  it("refuses when the worker's state is unknown", () => {
    const decision = decideRestoreAfterFailedRelease({ workerState: "unknown", tradingRowsWrittenSinceBackup: 0 });
    expect(decision.restore).toBe(false);
  });

  it("refuses when orders or trades were written after the backup", () => {
    expect(decideRestoreAfterFailedRelease({ workerState: "untouched", tradingRowsWrittenSinceBackup: 2 })).toEqual({
      restore: false,
      reason: "2 order/trade record(s) were written after the backup, and restoring would erase them",
    });
  });
});

describe("readInjectedReleaseFailure", () => {
  it("is off when unset", () => {
    expect(readInjectedReleaseFailure(undefined, "staging")).toBeNull();
  });

  it("injects only on staging", () => {
    expect(readInjectedReleaseFailure("after_migrations", "staging")).toBe("after_migrations");
    expect(readInjectedReleaseFailure("after_migrations", "production")).toBeNull();
    expect(readInjectedReleaseFailure("after_migrations", "development")).toBeNull();
  });

  it("rejects an unknown value on staging", () => {
    expect(() => readInjectedReleaseFailure("before_migrations", "staging")).toThrow(/after_migrations/);
  });
});
