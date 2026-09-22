import { describe, expect, it } from "vitest";
import { decideWorkerDeployAction } from "./decideWorkerDeployAction.js";

describe("decideWorkerDeployAction", () => {
  it("skips as unchanged when the hashes match", () => {
    const action = decideWorkerDeployAction({ localHash: "abcdef1234567890", storedHash: "abcdef1234567890" });
    expect(action).toEqual({ kind: "skip_unchanged", hashPrefix: "abcdef123456" });
  });

  it("deploys when the hashes differ", () => {
    const action = decideWorkerDeployAction({ localHash: "new-hash", storedHash: "old-hash" });
    expect(action).toEqual({ kind: "deploy", reason: "the worker's code hash differs from this release" });
  });

  it("deploys (fails safe) when the local hash could not be computed", () => {
    const action = decideWorkerDeployAction({ localHash: null, storedHash: "some-hash" });
    expect(action).toEqual({ kind: "deploy", reason: "could not compute this release's worker hash" });
  });

  it("deploys (fails safe) when the worker has never reported a hash", () => {
    expect(decideWorkerDeployAction({ localHash: "some-hash", storedHash: null })).toEqual({ kind: "deploy", reason: "the worker has not reported a code hash yet" });
    expect(decideWorkerDeployAction({ localHash: "some-hash", storedHash: undefined })).toEqual({ kind: "deploy", reason: "the worker has not reported a code hash yet" });
  });
});
