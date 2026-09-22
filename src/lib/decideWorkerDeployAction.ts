// Pure decision logic for the release-phase worker-deploy step (scripts/run-release-phase-worker-deploy.ts)
// — kept separate from that script's DB/SSH/Telegram I/O so the actual decision (skip vs. deploy,
// and why) is unit-testable without a live database, VPS, or Telegram.
export type WorkerDeployAction =
  | { kind: "skip_override"; reason: string }
  | { kind: "skip_unchanged"; hashPrefix: string }
  | { kind: "deploy"; reason: string };

export function decideWorkerDeployAction(params: {
  skipOverrideReason: string | undefined;
  localHash: string | null;
  storedHash: string | null | undefined;
}): WorkerDeployAction {
  if (params.skipOverrideReason) {
    return { kind: "skip_override", reason: params.skipOverrideReason };
  }
  if (params.localHash && params.storedHash && params.localHash === params.storedHash) {
    return { kind: "skip_unchanged", hashPrefix: params.localHash.slice(0, 12) };
  }
  const reason = !params.localHash
    ? "could not compute this release's worker hash"
    : !params.storedHash
      ? "the worker has not reported a code hash yet"
      : "the worker's code hash differs from this release";
  return { kind: "deploy", reason };
}
