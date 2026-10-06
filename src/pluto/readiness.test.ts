import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePlutoReadinessRun, describePlutoReadinessOutcome, plutoReadinessTestTimeoutMs, runPlutoReadinessTests, type PlutoReadinessRecord, type PlutoReadinessResult } from "./readiness.js";

// 2026-10-06 is EDT (UTC−4): 6:00 ET = 10:00Z, 9:20 ET = 13:20Z, 10:15 ET = 14:15Z.
const day = "2026-10-06";
const at = (utcTime: string) => new Date(`${day}T${utcTime}Z`);

function record(overrides: Partial<PlutoReadinessRecord> = {}): PlutoReadinessRecord {
  return { dateIso: day, lastRunAt: at("10:00:00").toISOString(), lastRunKind: "first", signature: "", finalDone: false, results: [], ...overrides };
}

const ok = (name: PlutoReadinessResult["name"]): PlutoReadinessResult => ({ name, ok: true, detail: "fine" });
const failed = (name: PlutoReadinessResult["name"], detail: string): PlutoReadinessResult => ({ name, ok: false, detail });

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
  const allPass = [ok("IBKR"), ok("API sign-in"), ok("OpenRouter")];
  const ibkrDown = [failed("IBKR", "no answer within 60 s"), ok("API sign-in"), ok("OpenRouter")];

  it("always posts the first run, listing every test, like the platform's 6:00 ET message", () => {
    expect(describePlutoReadinessOutcome("first", null, allPass)).toEqual({ signature: "", message: "✅ Pluto pre-open check passed.\n✅ IBKR: fine\n✅ API sign-in: fine\n✅ OpenRouter: fine", pause: false });
    const failedFirst = describePlutoReadinessOutcome("first", null, ibkrDown);
    expect(failedFirst).toMatchObject({ signature: "IBKR", pause: false });
    expect(failedFirst.message).toBe("⚠️ Pluto pre-open check failed.\n❌ IBKR: no answer within 60 s\n✅ API sign-in: fine\n✅ OpenRouter: fine\nRe-checking every 10 minutes. Pluto pauses at 9:20 ET if it still fails.");
  });

  it("stays quiet on a re-run with the same failures, and posts a change or a recovery", () => {
    expect(describePlutoReadinessOutcome("recheck", "IBKR", ibkrDown).message).toBeNull();
    expect(describePlutoReadinessOutcome("recheck", "IBKR", [failed("IBKR", "x"), failed("API sign-in", "401"), ok("OpenRouter")]).message).toContain("❌ API sign-in: 401");
    expect(describePlutoReadinessOutcome("recheck", "IBKR", allPass).message).toMatch(/^✅ Pluto pre-open check passes again\./);
  });

  it("always posts the 9:20 ET verdict: ready when every test passes", () => {
    expect(describePlutoReadinessOutcome("final", "", allPass)).toEqual({ signature: "", message: "✅ Pluto ready for today (9:20 ET check).\n✅ IBKR: fine\n✅ API sign-in: fine\n✅ OpenRouter: fine", pause: false });
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
      openRouter: async () => "$19.81 credit left",
    });
    expect(results).toEqual([
      { name: "IBKR", ok: true, detail: "connected and answered" },
      { name: "API sign-in", ok: false, detail: "Pluto service-user login failed: 401" },
      { name: "OpenRouter", ok: true, detail: "$19.81 credit left" },
    ]);
  });

  it("fails a probe that never answers once its time limit passes", async () => {
    vi.useFakeTimers();
    const running = runPlutoReadinessTests({ ibkr: () => new Promise(() => {}), apiSignIn: async () => "ok", openRouter: async () => "ok" });
    await vi.advanceTimersByTimeAsync(plutoReadinessTestTimeoutMs.IBKR);
    const results = await running;
    expect(results[0]).toEqual({ name: "IBKR", ok: false, detail: "no answer within 60 s" });
  });
});
