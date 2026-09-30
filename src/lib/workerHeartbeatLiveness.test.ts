import { describe, expect, it } from "vitest";
import { evaluateWorkerHeartbeat, workerHeartbeatAlertAfterMs } from "./workerHeartbeatLiveness.js";

const now = new Date("2026-10-01T15:00:00Z");
const beatAgo = (ms: number) => new Date(now.getTime() - ms);
const base = { now, serviceActive: true, restartedJustNow: false };

describe("evaluateWorkerHeartbeat", () => {
  it("is fine with a recent beat, and exactly at the limit", () => {
    expect(evaluateWorkerHeartbeat({ ...base, heartbeatAt: beatAgo(45_000) })).toBeNull();
    expect(evaluateWorkerHeartbeat({ ...base, heartbeatAt: beatAgo(workerHeartbeatAlertAfterMs) })).toBeNull();
  });

  it("reports a hung worker: service active but the heartbeat is stale", () => {
    expect(evaluateWorkerHeartbeat({ ...base, heartbeatAt: beatAgo(workerHeartbeatAlertAfterMs + 60_000) })).toContain("over 5 min old");
    expect(evaluateWorkerHeartbeat({ ...base, heartbeatAt: null })).toContain("has never been written");
  });

  it("stays quiet when the service is not active (the systemd check reports that) or was just restarted", () => {
    expect(evaluateWorkerHeartbeat({ ...base, serviceActive: false, heartbeatAt: beatAgo(60 * 60_000) })).toBeNull();
    expect(evaluateWorkerHeartbeat({ ...base, restartedJustNow: true, heartbeatAt: beatAgo(60 * 60_000) })).toBeNull();
  });

  it("when the service state is unknown (an earlier health-check step failed) it still reports a stale heartbeat, without claiming the service is active", () => {
    const message = evaluateWorkerHeartbeat({ ...base, serviceActive: null, heartbeatAt: beatAgo(workerHeartbeatAlertAfterMs + 60_000) });
    expect(message).toContain("service state was not checked");
    expect(message).toContain("hung or stopped");
    expect(evaluateWorkerHeartbeat({ ...base, serviceActive: null, heartbeatAt: beatAgo(45_000) })).toBeNull();
  });
});
