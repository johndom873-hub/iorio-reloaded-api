import { describe, expect, it } from "vitest";
import { easternDateIso } from "./marketSessionStatus.js";
import { evaluateJobDeadlines, type JobRunSummary } from "./jobDeadlines.js";

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

  it("judges the option-chain chain at 10:05 ET in summer time (14:05 UTC)", () => {
    expect(keys(evaluate("2026-10-01T14:04:00Z", [recentHealthCheck("2026-10-01T14:04:00Z")])).filter((key) => key.includes("option_chain_capture"))).toEqual([]);
    expect(keys(evaluate("2026-10-01T14:06:00Z", [recentHealthCheck("2026-10-01T14:06:00Z")]))).toContain("deadline:option_chain_capture:2026-10-01");
  });

  it("judges the option-chain chain at 10:05 ET in winter time (15:05 UTC)", () => {
    expect(keys(evaluate("2026-12-01T15:04:00Z", [recentHealthCheck("2026-12-01T15:04:00Z")])).filter((key) => key.includes("option_chain_capture"))).toEqual([]);
    expect(keys(evaluate("2026-12-01T15:06:00Z", [recentHealthCheck("2026-12-01T15:06:00Z")]))).toContain("deadline:option_chain_capture:2026-12-01");
  });

  it("does not require the fit and seed until 10:15 ET", () => {
    const now = "2026-10-01T14:12:00Z";
    const problems = keys(evaluate(now, [recentHealthCheck(now), run("option_chain_capture", "2026-10-01T13:30:10Z")]));
    expect(problems.filter((key) => key.includes("option_chain_capture") || key.includes("option_surface_fit") || key.includes("day_signals_seed"))).toEqual([]);
    expect(keys(evaluate("2026-10-01T14:16:00Z", [recentHealthCheck("2026-10-01T14:16:00Z"), run("option_chain_capture", "2026-10-01T13:30:10Z")]))).toEqual(expect.arrayContaining(["deadline:option_surface_fit:2026-10-01", "deadline:day_signals_seed:2026-10-01"]));
  });

  it("reports a run stuck in running past its normal duration", () => {
    const now = "2026-10-01T22:50:00Z";
    const problems = evaluate(now, [recentHealthCheck(now), run("daily_market_data_capture", "2026-10-01T22:00:05Z", "running")]);
    expect(keys(problems).filter((key) => key.includes("daily_market_data_capture"))).toEqual(["deadline:daily_market_data_capture:stuck:2026-10-01T22:00:05.000Z"]);
  });

  it("reports a silent ibkr_health_check, and none at all", () => {
    expect(keys(evaluate("2026-10-01T05:00:00Z", [run("ibkr_health_check", "2026-10-01T04:30:00Z")]))).toEqual(["deadline:ibkr_health_check"]);
    expect(evaluate("2026-10-01T05:00:00Z", [])[0]?.message).toContain("no recorded run at all");
    expect(evaluate("2026-10-01T05:00:00Z", [run("ibkr_health_check", "2026-10-01T04:45:00Z")])).toEqual([]);
  });
});
