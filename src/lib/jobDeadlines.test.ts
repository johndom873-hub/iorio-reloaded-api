import { describe, expect, it } from "vitest";
import { easternDateIso } from "./marketSessionStatus.js";
import { chainCaptureSlotEastern, evaluateJobDeadlines, evaluatePendingJobs, expectedScheduledJobs, runFallsInSlot, type JobRunSummary } from "./jobDeadlines.js";
import { isWithinChainCaptureClockWindow } from "./optionChainCaptureClock.js";
import { easternInstant } from "./marketSessionStatus.js";

const utc = (iso: string) => new Date(iso);
const run = (jobName: string, startedAt: string, status: JobRunSummary["status"] = "success"): JobRunSummary => ({ jobName, startedAt: utc(startedAt), status });
const evaluate = (now: string, runs: JobRunSummary[], isOpenDay = true) => evaluateJobDeadlines({ now: utc(now), runs, isOpenDay: () => isOpenDay, easternDateIsoOf: easternDateIso });
const keys = (problems: { alertKey: string }[]) => problems.map((problem) => problem.alertKey);
const recentHealthCheck = (now: string) => run("ibkr_health_check", new Date(utc(now).getTime() - 5 * 60_000).toISOString());

describe("evaluateJobDeadlines", () => {
  it("reports a UTC-slot job that has not started once its grace has passed", () => {
    const now = "2026-10-01T12:11:00Z";
    expect(keys(evaluate(now, [recentHealthCheck(now)]))).toEqual(["deadline:option_chain_structure_refresh:2026-10-01"]);
  });

  it("stays quiet before the deadline", () => {
    const now = "2026-10-01T12:09:00Z";
    expect(evaluate(now, [recentHealthCheck(now)])).toEqual([]);
  });

  it("counts any run since the slot as started, including a failure (runJob already alerted it)", () => {
    const now = "2026-10-01T12:30:00Z";
    expect(evaluate(now, [recentHealthCheck(now), run("option_chain_structure_refresh", "2026-10-01T12:00:04Z", "failure")])).toEqual([]);
  });

  it("ignores yesterday's run", () => {
    const now = "2026-10-01T12:30:00Z";
    expect(keys(evaluate(now, [recentHealthCheck(now), run("option_chain_structure_refresh", "2026-09-30T12:00:04Z")]))).toContain("deadline:option_chain_structure_refresh:2026-10-01");
  });

  it("skips market-days-only jobs on a closed day but still checks the every-day ones", () => {
    const now = "2026-10-03T23:30:00Z";
    const problems = keys(evaluate(now, [recentHealthCheck(now)], false));
    expect(problems).toContain("deadline:expiry_settlement_audit:2026-10-03");
    expect(problems).toContain("deadline:daily_calendar_capture:2026-10-03");
    expect(problems.some((key) => key.includes("daily_market_data_capture"))).toBe(false);
  });

  it("judges the option-chain chain at 10:35 ET in summer time (14:35 UTC)", () => {
    expect(keys(evaluate("2026-10-01T14:34:00Z", [recentHealthCheck("2026-10-01T14:34:00Z")])).filter((key) => key.includes("option_chain_capture"))).toEqual([]);
    expect(keys(evaluate("2026-10-01T14:36:00Z", [recentHealthCheck("2026-10-01T14:36:00Z")]))).toContain("deadline:option_chain_capture:2026-10-01");
  });

  it("judges the option-chain chain at 10:35 ET in winter time (15:35 UTC)", () => {
    expect(keys(evaluate("2026-12-01T15:34:00Z", [recentHealthCheck("2026-12-01T15:34:00Z")])).filter((key) => key.includes("option_chain_capture"))).toEqual([]);
    expect(keys(evaluate("2026-12-01T15:36:00Z", [recentHealthCheck("2026-12-01T15:36:00Z")]))).toContain("deadline:option_chain_capture:2026-12-01");
  });

  it("does not require the fit and seed until 11:00 ET (they follow the capture and its retry rounds)", () => {
    const now = "2026-10-01T14:42:00Z";
    const problems = keys(evaluate(now, [recentHealthCheck(now), run("option_chain_capture", "2026-10-01T14:00:10Z")]));
    expect(problems.filter((key) => key.includes("option_chain_capture") || key.includes("option_surface_fit") || key.includes("day_signals_seed"))).toEqual([]);
    expect(keys(evaluate("2026-10-01T15:01:00Z", [recentHealthCheck("2026-10-01T15:01:00Z"), run("option_chain_capture", "2026-10-01T14:00:10Z")]))).toEqual(expect.arrayContaining(["deadline:option_surface_fit:2026-10-01", "deadline:day_signals_seed:2026-10-01"]));
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
    const capture = expectedScheduledJobs.find((candidate) => candidate.jobName === "option_chain_capture")!;
    expect(runFallsInSlot(capture, "2026-10-01", new Date("2026-10-01T14:00:10Z"))).toBe(true);
    expect(runFallsInSlot(capture, "2026-10-01", new Date("2026-10-02T14:00:10Z"))).toBe(false);
  });
});

describe("the monitor's capture slot follows the clock guard", () => {
  // jobDeadlines.ts and optionChainCaptureClock.ts each hold the capture time. If one is changed alone the monitor
  // would alert about a slot the capture no longer runs in (or stay silent about the real one): fail loudly instead.
  it("the guard's window opens exactly at the monitor's slot, in summer and in winter time", () => {
    for (const dateIso of ["2026-07-15", "2026-12-15", "2026-03-09", "2026-11-02"]) {
      const slot = easternInstant(dateIso, chainCaptureSlotEastern.hour, chainCaptureSlotEastern.minute);
      expect(isWithinChainCaptureClockWindow(new Date(slot.getTime() - 60_000))).toBe(false);
      expect(isWithinChainCaptureClockWindow(new Date(slot.getTime() + 60_000))).toBe(true);
    }
  });
});

describe("evaluatePendingJobs", () => {
  const pending = (now: string, runs: JobRunSummary[], isOpenDay = true) => evaluatePendingJobs({ now: utc(now), runs, isOpenDay: () => isOpenDay, easternDateIsoOf: easternDateIso });

  it("lists the capture chain between its slot and its deadline when it has not started, and nothing once it has", () => {
    // 10:45 ET summer = 14:45 UTC: capture slot 10:00 (deadline 10:35 passed -> a problem, not pending); fit/seed deadline 11:00 -> pending
    expect(pending("2026-10-01T14:45:00Z", [run("option_chain_capture", "2026-10-01T14:00:10Z")])).toEqual(["option_surface_fit", "day_signals_seed"]);
    expect(pending("2026-10-01T14:45:00Z", [run("option_chain_capture", "2026-10-01T14:00:10Z"), run("option_surface_fit", "2026-10-01T14:10:00Z"), run("day_signals_seed", "2026-10-01T14:10:30Z")])).toEqual([]);
  });

  it("lists nothing before the slot has begun, on closed days, or for evening jobs at 10:45 ET", () => {
    expect(pending("2026-10-01T13:50:00Z", [])).not.toContain("option_chain_capture");
    // On a closed day no market-days-only job is expected, so none can be pending (every-day jobs are not due yet at 14:45 UTC either).
    expect(pending("2026-10-03T14:45:00Z", [], false)).toEqual([]);
    expect(pending("2026-10-01T14:45:00Z", [])).not.toContain("daily_pnl_snapshot");
  });
});
