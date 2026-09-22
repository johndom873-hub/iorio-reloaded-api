import { describe, expect, it } from "vitest";
import { decideWorkerDeployAction } from "./decideWorkerDeployAction.js";

describe("decideWorkerDeployAction", () => {
  it("skips via the explicit override, regardless of hashes", () => {
    const action = decideWorkerDeployAction({ skipOverrideReason: "VPS down for maintenance", localHash: "abc", storedHash: "abc" });
    expect(action).toEqual({ kind: "skip_override", reason: "VPS down for maintenance" });
  });

  it("skips as unchanged when the hashes match", () => {
    const action = decideWorkerDeployAction({ skipOverrideReason: undefined, localHash: "abcdef1234567890", storedHash: "abcdef1234567890" });
    expect(action).toEqual({ kind: "skip_unchanged", hashPrefix: "abcdef123456" });
  });

  it("deploys when the hashes differ", () => {
    const action = decideWorkerDeployAction({ skipOverrideReason: undefined, localHash: "new-hash", storedHash: "old-hash" });
    expect(action).toEqual({ kind: "deploy", reason: "the worker's code hash differs from this release" });
  });

  it("deploys (fails safe) when the local hash could not be computed", () => {
    const action = decideWorkerDeployAction({ skipOverrideReason: undefined, localHash: null, storedHash: "some-hash" });
    expect(action).toEqual({ kind: "deploy", reason: "could not compute this release's worker hash" });
  });

  it("deploys (fails safe) when the worker has never reported a hash", () => {
    const action = decideWorkerDeployAction({ skipOverrideReason: undefined, localHash: "some-hash", storedHash: null });
    expect(action).toEqual({ kind: "deploy", reason: "the worker has not reported a code hash yet" });
    const actionUndefined = decideWorkerDeployAction({ skipOverrideReason: undefined, localHash: "some-hash", storedHash: undefined });
    expect(actionUndefined).toEqual({ kind: "deploy", reason: "the worker has not reported a code hash yet" });
  });

  it("prefers the override even when the local hash is null", () => {
    const action = decideWorkerDeployAction({ skipOverrideReason: "manual override", localHash: null, storedHash: null });
    expect(action.kind).toBe("skip_override");
  });
});
