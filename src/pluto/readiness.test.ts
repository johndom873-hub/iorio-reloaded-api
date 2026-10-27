import { afterEach, describe, expect, it, vi } from "vitest";
import { assemblePlutoReadinessResults, decidePlutoReadinessRun, describePlutoReadinessOutcome, evaluatePlutoRunning, plutoReadinessTestTimeoutMs, runPlutoReadinessTests, type PlutoReadinessRecord, type PlutoReadinessResult } from "./readiness.js";

// 2026-10-06 is EDT (UTC−4): 6:00 ET = 10:00Z, 9:20 ET = 13:20Z, 10:15 ET = 14:15Z.
const day = "2026-10-06";
const at = (utcTime: string) => new Date(`${day}T${utcTime}Z`);

function record(overrides: Partial<PlutoReadinessRecord> = {}): PlutoReadinessRecord {
  return { dateIso: day, lastRunAt: at("10:00:00").toISOString(), lastRunKind: "first", signature: "", finalDone: false, results: [], ...overrides };
}

const ok = (name: PlutoReadinessResult["name"]): PlutoReadinessResult => ({ name, ok: true, status: "ok", detail: "fine" });
const failed = (name: PlutoReadinessResult["name"], detail: string): PlutoReadinessResult => ({ name, ok: false, status: "fail", detail });
const warned = (name: PlutoReadinessResult["name"], detail: string): PlutoReadinessResult => ({ name, ok: false, status: "warn", detail });

describe("decidePlutoReadinessRun", () => {
  it("does nothing before 6:00 ET", () => {
    expect(decidePlutoReadinessRun(at("09:59:00"), day, null)).toBeNull();
  });

  it("runs the first check at 6:00 ET, and as a catch-up when the agent starts later in the morning", () => {
    expect(decidePlutoReadinessRun(at("10:00:00"), day, null)).toBe("first");
    expect(decidePlutoReadinessRun(at("12:55:00"), day, null)).toBe("first");
  });

  it("treats yesterday's record as no run today", () => {
    expect(decidePlutoReadinessRun(at("10:00:00"), day, record({ dateIso: "2026-10-05", finalDone: true }))).toBe("first");
  });

  it("stays quiet after a passing run until the final check", () => {
    expect(decidePlutoReadinessRun(at("12:00:00"), day, record())).toBeNull();
  });

  it("re-runs a failing check every 10 minutes, not sooner", () => {
    const failing = record({ signature: "IBKR" });
    expect(decidePlutoReadinessRun(at("10:09:59"), day, failing)).toBeNull();
    expect(decidePlutoReadinessRun(at("10:10:00"), day, failing)).toBe("recheck");
  });

  it("runs the final check from 9:20 ET, once, and not after 10:15 ET", () => {
    expect(decidePlutoReadinessRun(at("13:20:00"), day, record())).toBe("final");
    expect(decidePlutoReadinessRun(at("13:20:00"), day, null)).toBe("final");
    expect(decidePlutoReadinessRun(at("13:25:00"), day, record({ finalDone: true }))).toBeNull();
    expect(decidePlutoReadinessRun(at("14:15:00"), day, null)).toBeNull();
  });
});

describe("describePlutoReadinessOutcome", () => {
  const allPass = [ok("IBKR"), ok("API sign-in")];
  const ibkrDown = [failed("IBKR", "no answer within 60 s"), ok("API sign-in")];

  it("always posts the first run, listing every test, like the platform's 6:00 ET message", () => {
    expect(describePlutoReadinessOutcome("first", null, allPass)).toEqual({ signature: "", message: "✅ Pluto pre-open check passed.\n✅ IBKR: fine\n✅ API sign-in: fine", pause: false });
    const failedFirst = describePlutoReadinessOutcome("first", null, ibkrDown);
    expect(failedFirst).toMatchObject({ signature: "IBKR", pause: false });
    expect(failedFirst.message).toBe("⚠️ Pluto pre-open check failed.\n❌ IBKR: no answer within 60 s\n✅ API sign-in: fine\nRe-checking every 10 minutes. Pluto pauses at 9:20 ET if it still fails.");
  });

  it("stays quiet on a re-run with the same failures, and posts a change or a recovery", () => {
    expect(describePlutoReadinessOutcome("recheck", "IBKR", ibkrDown).message).toBeNull();
    expect(describePlutoReadinessOutcome("recheck", "IBKR", [failed("IBKR", "x"), failed("API sign-in", "401")]).message).toContain("❌ API sign-in: 401");
    expect(describePlutoReadinessOutcome("recheck", "IBKR", allPass).message).toMatch(/^✅ Pluto pre-open check passes again\./);
  });

  it("always posts the 9:20 ET verdict: ready when every test passes", () => {
    expect(describePlutoReadinessOutcome("final", "", allPass)).toEqual({ signature: "", message: "✅ Pluto ready for today (9:20 ET check).\n✅ IBKR: fine\n✅ API sign-in: fine", pause: false });
    expect(describePlutoReadinessOutcome("final", null, allPass).message).toMatch(/^✅ Pluto ready for today/);
  });

  it("pauses at the final run when anything still fails, and says so", () => {
    const outcome = describePlutoReadinessOutcome("final", "IBKR", ibkrDown);
    expect(outcome.pause).toBe(true);
    expect(outcome.message).toContain("the 9:20 ET check still fails, so Pluto is paused");
    expect(outcome.message).toContain("❌ IBKR: no answer within 60 s");
    expect(outcome.message).toContain("Press Resume");
  });
});

describe("evaluatePlutoRunning", () => {
  it("passes only when Pluto is on and not paused", () => {
    expect(evaluatePlutoRunning({ mode: "on", paused: false, pauseReason: null })).toEqual({ name: "Pluto running", ok: true, status: "ok", detail: "on and not paused" });
  });

  it("only warns when Pluto is switched off: it is not meant to trade today", () => {
    expect(evaluatePlutoRunning({ mode: "off", paused: false, pauseReason: null })).toEqual({ name: "Pluto running", ok: false, status: "warn", detail: "switched off, so it will not trade today" });
  });

  it("fails when Pluto is on but paused, naming why", () => {
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "deploy" }).status).toBe("fail");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "deploy" }).detail).toBe("paused after a deploy");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "manual" }).detail).toBe("paused by a person");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "crash_loop" }).detail).toBe("paused after repeated restarts");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "readiness" }).detail).toBe("paused by an earlier pre-open check");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "breaker:daily_loss" }).detail).toBe("paused, the daily loss breaker is tripped");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: null }).detail).toBe("paused");
  });

  it("treats off and paused as off: a warning", () => {
    expect(evaluatePlutoRunning({ mode: "off", paused: true, pauseReason: "manual" })).toMatchObject({ status: "warn", detail: "switched off, so it will not trade today" });
  });
});

describe("assemblePlutoReadinessResults", () => {
  const probes = [failed("IBKR", "no answer within 60 s"), ok("API sign-in")];
  it("keeps a failed probe an error when Pluto is on, paused or not", () => {
    expect(assemblePlutoReadinessResults(probes, { mode: "on", paused: false, pauseReason: null }).map((result) => result.status)).toEqual(["fail", "ok", "ok"]);
    expect(assemblePlutoReadinessResults(probes, { mode: "on", paused: true, pauseReason: "deploy" }).map((result) => result.status)).toEqual(["fail", "ok", "fail"]);
  });
  it("turns a failed probe into a warning when Pluto is switched off", () => {
    const results = assemblePlutoReadinessResults(probes, { mode: "off", paused: false, pauseReason: null });
    expect(results.map((result) => [result.name, result.ok, result.status])).toEqual([
      ["IBKR", false, "warn"],
      ["API sign-in", true, "ok"],
      ["Pluto running", false, "warn"],
    ]);
  });
  it("re-grades reused probe results from an earlier run by today's mode", () => {
    expect(assemblePlutoReadinessResults([warned("IBKR", "x")], { mode: "on", paused: false, pauseReason: null })[0]!.status).toBe("fail");
  });
});

describe("describePlutoReadinessOutcome with the Pluto running test", () => {
  const running = ok("Pluto running");
  const notRunning = failed("Pluto running", "paused after a deploy");
  const probesPass = [ok("IBKR"), ok("API sign-in")];
  const ibkrDown = failed("IBKR", "no answer within 60 s");

  it("shows the tick with the other tests when Pluto is running", () => {
    expect(describePlutoReadinessOutcome("first", null, [...probesPass, running]).message).toBe("✅ Pluto pre-open check passed.\n✅ IBKR: fine\n✅ API sign-in: fine\n✅ Pluto running: fine");
  });

  it("alerts at 6:00 ET when Pluto is paused, without promising a pause that cannot happen", () => {
    const outcome = describePlutoReadinessOutcome("first", null, [...probesPass, notRunning]);
    expect(outcome).toMatchObject({ signature: "Pluto running", pause: false });
    expect(outcome.message).toBe("⚠️ Pluto pre-open check failed.\n❌ Pluto running: paused after a deploy\n✅ IBKR: fine\n✅ API sign-in: fine\nRe-checking every 10 minutes.");
  });

  it("keeps the pause warning when a probe fails on a running Pluto", () => {
    expect(describePlutoReadinessOutcome("first", null, [ibkrDown, ok("API sign-in"), running]).message).toContain("Pluto pauses at 9:20 ET if it still fails.");
  });

  it("says Pluto is paused at 9:20 ET, and does not pause again", () => {
    const outcome = describePlutoReadinessOutcome("final", "Pluto running", [...probesPass, notRunning]);
    expect(outcome.pause).toBe(false);
    expect(outcome.message).toMatch(/^🛑 Pluto is paused at the 9:20 ET check\./);
    expect(outcome.message).toContain("❌ Pluto running: paused after a deploy");
    expect(outcome.message).toContain("Resume it on the Pluto screen");
  });

  it("does not pause an already paused Pluto when a probe also fails at 9:20 ET", () => {
    const outcome = describePlutoReadinessOutcome("final", "", [ibkrDown, ok("API sign-in"), notRunning]);
    expect(outcome.pause).toBe(false);
    expect(outcome.message).toContain("and Pluto is paused");
    expect(outcome.message).not.toContain("so Pluto is paused");
  });

  it("reports a switched-off Pluto as a warning, with no failure, no re-checks and no pause, its failed probes as warnings", () => {
    const switchedOff = warned("Pluto running", "switched off, so it will not trade today");
    const first = describePlutoReadinessOutcome("first", null, [warned("IBKR", "no answer within 60 s"), ok("API sign-in"), switchedOff]);
    expect(first).toEqual({
      signature: "",
      message: "⚠️ Pluto is switched off, so it will not trade today.\n⚠️ IBKR: no answer within 60 s\n⚠️ Pluto running: switched off, so it will not trade today\n✅ API sign-in: fine",
      pause: false,
    });
    const final = describePlutoReadinessOutcome("final", "", [...probesPass, switchedOff]);
    expect(final.pause).toBe(false);
    expect(final.message).toMatch(/^⚠️ Pluto is switched off at the 9:20 ET check, so it will not trade today\./);
    expect(final.message).toContain("Switch it on on the Pluto screen");
  });

  it("still pauses a running Pluto when a probe fails at 9:20 ET", () => {
    const outcome = describePlutoReadinessOutcome("final", "IBKR", [ibkrDown, ok("API sign-in"), running]);
    expect(outcome.pause).toBe(true);
    expect(outcome.message).toContain("so Pluto is paused");
  });

  it("announces the recovery once Pluto is resumed", () => {
    expect(describePlutoReadinessOutcome("recheck", "Pluto running", [...probesPass, running]).message).toMatch(/^✅ Pluto pre-open check passes again\./);
    expect(describePlutoReadinessOutcome("recheck", "Pluto running", [...probesPass, notRunning]).message).toBeNull();
  });
});

describe("runPlutoReadinessTests", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports each probe's own result, turning a thrown error into a failure", async () => {
    const results = await runPlutoReadinessTests({
      ibkr: async () => "connected and answered",
      apiSignIn: async () => {
        throw new Error("Pluto service-user login failed: 401");
      },
    });
    expect(results).toEqual([
      { name: "IBKR", ok: true, status: "ok", detail: "connected and answered" },
      { name: "API sign-in", ok: false, status: "fail", detail: "Pluto service-user login failed: 401" },
    ]);
  });

  it("fails a probe that never answers once its time limit passes", async () => {
    vi.useFakeTimers();
    const running = runPlutoReadinessTests({ ibkr: () => new Promise(() => {}), apiSignIn: async () => "ok" });
    await vi.advanceTimersByTimeAsync(plutoReadinessTestTimeoutMs.IBKR);
    const results = await running;
    expect(results[0]).toEqual({ name: "IBKR", ok: false, status: "fail", detail: "no answer within 60 s" });
  });
});
