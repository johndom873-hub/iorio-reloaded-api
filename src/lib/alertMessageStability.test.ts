import { describe, expect, it } from "vitest";
import { evaluateDaySignalsLiveness } from "./daySignalsLiveness.js";
import { evaluateJobDeadlines } from "./jobDeadlines.js";
import { evaluateOpsMonitorLiveness } from "./opsMonitorLiveness.js";
import { evaluateWorkerHeartbeat } from "./workerHeartbeatLiveness.js";
import { easternIsoDate } from "./easternIsoDate.js";

// throttledAlert.notifyDownThrottled treats a CHANGED message as a new alert and sends it immediately, so any
// alert text that embeds a live counter ("stuck for 181 min") would page every minute instead of at the
// reminder interval. Found in review 2026-09-30: every state-based alert must be byte-identical while the
// underlying condition persists.

const minute = 60_000;
const at = (iso: string, plusMinutes: number) => new Date(new Date(iso).getTime() + plusMinutes * minute);

describe("state-based alert texts do not change while the condition persists", () => {
  it("job deadline alerts: not started, stuck, and health check silent", () => {
    const run = (jobName: string, startedAt: string, status: "running" | "success" | "failure") => ({ jobName, startedAt: new Date(startedAt), status });
    const evaluate = (now: Date) =>
      evaluateJobDeadlines({
        now,
        runs: [run("daily_market_data_capture", "2026-10-01T22:00:05Z", "running"), run("ibkr_health_check", "2026-10-01T18:00:00Z", "success")],
        isOpenDay: () => true,
        easternDateIsoOf: easternIsoDate,
      }).map((problem) => `${problem.alertKey} => ${problem.message}`);
    const first = evaluate(new Date("2026-10-01T23:05:00Z"));
    expect(first.length).toBeGreaterThan(2);
    for (const later of [1, 2, 7, 60]) expect(evaluate(at("2026-10-01T23:05:00Z", later)).filter((line) => line.includes("stuck") || line.includes("ibkr_health_check"))).toEqual(first.filter((line) => line.includes("stuck") || line.includes("ibkr_health_check")));
  });

  it("ops monitor, worker and Day Signals liveness alerts", () => {
    const now = new Date("2026-10-01T15:00:00Z");
    const staleFor = (minutes: number) => new Date(now.getTime() - minutes * minute);
    expect(evaluateOpsMonitorLiveness({ now, heartbeatAt: staleFor(8) })).toBe(evaluateOpsMonitorLiveness({ now, heartbeatAt: staleFor(90) }));
    expect(evaluateWorkerHeartbeat({ now, heartbeatAt: staleFor(8), serviceActive: true, restartedJustNow: false })).toBe(evaluateWorkerHeartbeat({ now, heartbeatAt: staleFor(90), serviceActive: true, restartedJustNow: false }));
    const day = (heartbeatMinutes: number, quoteMinutes: number | null) =>
      evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: { updatedAt: staleFor(heartbeatMinutes), connected: true, uptimeMs: 3 * 60 * minute }, latestQuoteAt: quoteMinutes === null ? null : staleFor(quoteMinutes) });
    expect(day(9, 1)).toBe(day(120, 1));
    expect(day(1, 20)).toBe(day(1, 200));
    expect(day(1, 20)).toBeTruthy();
  });
});
