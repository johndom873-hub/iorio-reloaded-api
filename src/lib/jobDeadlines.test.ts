import { describe, expect, it } from "vitest";
import { evaluateJobDeadlines, evaluatePendingJobs, expectedScheduledJobs, runFallsInSlot, type JobRunSummary } from "./jobDeadlines.js";
import { easternIsoDate } from "./easternIsoDate.js";

const utc = (iso: string) => new Date(iso);
const run = (jobName: string, startedAt: string, status: JobRunSummary["status"] = "success"): JobRunSummary => ({ jobName, startedAt: utc(startedAt), status });
const evaluate = (now: string, runs: JobRunSummary[], isOpenDay = true) => evaluateJobDeadlines({ now: utc(now), runs, isOpenDay: () => isOpenDay, easternDateIsoOf: easternIsoDate });
const keys = (problems: { alertKey: string }[]) => problems.map((problem) => problem.alertKey);
const recentHealthCheck = (now: string) => run("ibkr_health_check", new Date(utc(now).getTime() - 5 * 60_000).toISOString());

describe("evaluateJobDeadlines", () => {
  it("reports a UTC-slot job that has not started once its grace has passed", () => {
    const now = "2026-10-01T09:11:00Z";
    expect(keys(evaluate(now, [recentHealthCheck(now)]))).toEqual(["deadline:option_chain_structure_refresh:2026-10-01", "deadline:session_close_read:2026-10-01"]);
  });

  it("stays quiet before the deadline", () => {
    const now = "2026-10-01T09:09:00Z";
    expect(evaluate(now, [recentHealthCheck(now)])).toEqual([]);
  });

  it("counts any run since the slot as started, including a failure (runJob already alerted it)", () => {
    const now = "2026-10-01T09:30:00Z";
    expect(evaluate(now, [recentHealthCheck(now), run("session_close_read", "2026-10-01T09:00:02Z", "success"), run("option_chain_structure_refresh", "2026-10-01T09:00:04Z", "failure")])).toEqual([]);
  });

  it("ignores yesterday's run", () => {
    const now = "2026-10-01T09:30:00Z";
    expect(keys(evaluate(now, [recentHealthCheck(now), run("option_chain_structure_refresh", "2026-09-30T09:00:04Z")]))).toContain("deadline:option_chain_structure_refresh:2026-10-01");
  });

  it("skips market-days-only jobs on a closed day but still checks the every-day ones", () => {
    const now = "2026-10-03T23:30:00Z";
    const problems = keys(evaluate(now, [recentHealthCheck(now)], false));
    expect(problems).toContain("deadline:expiry_settlement_audit:2026-10-03");
    expect(problems).toContain("deadline:daily_calendar_capture:2026-10-03");
    expect(problems.some((key) => key.includes("daily_market_data_capture"))).toBe(false);
  });

  it("reports a run stuck in running past its normal duration", () => {
    const now = "2026-10-01T23:10:00Z";
    const problems = evaluate(now, [recentHealthCheck(now), run("daily_market_data_capture", "2026-10-01T22:00:05Z", "running")]);
    expect(keys(problems).filter((key) => key.includes("daily_market_data_capture"))).toEqual(["deadline:daily_market_data_capture:stuck:2026-10-01T22:00:05.000Z"]);
  });

  it("reports a silent ibkr_health_check, and none at all", () => {
    expect(keys(evaluate("2026-10-01T05:00:00Z", [run("ibkr_health_check", "2026-10-01T04:30:00Z")]))).toEqual(["deadline:ibkr_health_check"]);
    expect(evaluate("2026-10-01T05:00:00Z", [])[0]?.message).toContain("no recorded run at all");
    expect(evaluate("2026-10-01T05:00:00Z", [run("ibkr_health_check", "2026-10-01T04:45:00Z")])).toEqual([]);
  });
});

describe("alert text is in Eastern time", () => {
  it("states the slot and deadline in ET, not UTC", () => {
    const now = "2026-10-01T09:11:00Z";
    const message = evaluate(now, [recentHealthCheck(now)])[0]?.message ?? "";
    // 09:00 UTC is 05:00 ET (EDT); deadline 10 minutes later.
    expect(message).toContain("has not started for 2026-10-01 (was due 05:00 ET, deadline passed at 05:10 ET)");
    expect(message).not.toContain("UTC");
  });

  it("uses winter time after the clocks change", () => {
    const now = "2026-11-03T09:11:00Z";
    const message = evaluate(now, [recentHealthCheck(now)])[0]?.message ?? "";
    expect(message).toContain("(was due 04:00 ET, deadline passed at 04:10 ET)");
  });

  it("gives the start of a stuck run as an Eastern date and time", () => {
    const now = "2026-10-01T23:10:00Z";
    const message = evaluate(now, [recentHealthCheck(now), run("daily_market_data_capture", "2026-10-01T22:00:05Z", "running")]).find((problem) => problem.alertKey.includes("stuck"))?.message ?? "";
    expect(message).toContain("(started Thu 10-01 18:00 ET)");
  });
});

describe("stuck runs and slot windows", () => {
  it("keeps reporting a run that is stuck across UTC midnight", () => {
    const stuck = run("daily_market_data_capture", "2026-10-01T22:00:05Z", "running");
    for (const now of ["2026-10-01T23:30:00Z", "2026-10-02T00:30:00Z", "2026-10-02T06:00:00Z"]) {
      expect(keys(evaluate(now, [recentHealthCheck(now), stuck])).filter((key) => key.includes("stuck"))).toEqual(["deadline:daily_market_data_capture:stuck:2026-10-01T22:00:05.000Z"]);
    }
  });

  it("runFallsInSlot: only a run inside that date's slot resolves that date's alert, not the next day's run", () => {
    const job = expectedScheduledJobs.find((candidate) => candidate.jobName === "daily_market_data_capture")!;
    expect(runFallsInSlot(job, "2026-10-01", new Date("2026-10-01T22:04:00Z"))).toBe(true);
    expect(runFallsInSlot(job, "2026-10-01", new Date("2026-10-02T22:00:05Z"))).toBe(false);
    expect(runFallsInSlot(job, "2026-10-01", new Date("2026-10-01T10:00:00Z"))).toBe(false);
  });
});

describe("evaluatePendingJobs", () => {
  const pending = (now: string, runs: JobRunSummary[], isOpenDay = true) => evaluatePendingJobs({ now: utc(now), runs, isOpenDay: () => isOpenDay, easternDateIsoOf: easternIsoDate });

  it("lists the 9:00 UTC jobs between their slot and their deadline when they have not started, and nothing once they have", () => {
    expect(pending("2026-10-01T09:05:00Z", [])).toEqual(["option_chain_structure_refresh", "session_close_read", "ladder_split_check"]);
    expect(pending("2026-10-01T09:05:00Z", [run("option_chain_structure_refresh", "2026-10-01T09:00:04Z"), run("session_close_read", "2026-10-01T09:00:02Z"), run("ladder_split_check", "2026-10-01T09:03:00Z")])).toEqual([]);
  });

  it("lists nothing before the slot has begun, on closed days, or for evening jobs at 10:45 ET", () => {
    expect(pending("2026-10-01T08:50:00Z", [])).not.toContain("option_chain_structure_refresh");
    // On a closed day no market-days-only job is expected, so none can be pending (every-day jobs are not due yet at 14:45 UTC either).
    expect(pending("2026-10-03T14:45:00Z", [], false)).toEqual([]);
    expect(pending("2026-10-01T14:45:00Z", [])).not.toContain("daily_pnl_snapshot");
  });
});
