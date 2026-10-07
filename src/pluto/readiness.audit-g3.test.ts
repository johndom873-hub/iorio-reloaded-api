import { describe, expect, it } from "vitest";
import { decidePlutoReadinessRun, describePlutoReadinessOutcome, evaluatePlutoRunning, plutoReadinessSignature, plutoReadinessTestNames, type PlutoReadinessRecord, type PlutoReadinessResult } from "./readiness.js";

// Audit (G3, 2026-10-07): readiness.ts edges not covered by readiness.test.ts.

const ok = (name: PlutoReadinessResult["name"]): PlutoReadinessResult => ({ name, ok: true, detail: "fine" });
const failed = (name: PlutoReadinessResult["name"], detail = "broken"): PlutoReadinessResult => ({ name, ok: false, detail });
const record = (dateIso: string, overrides: Partial<PlutoReadinessRecord> = {}): PlutoReadinessRecord => ({ dateIso, lastRunAt: `${dateIso}T11:00:00.000Z`, lastRunKind: "first", signature: "", finalDone: false, results: [], ...overrides });

describe("decidePlutoReadinessRun in winter time (EST, UTC-5) (audit)", () => {
  // 2097-01-15 is a Tuesday in EST: 6:00 ET = 11:00Z, 9:20 ET = 14:20Z, 10:15 ET = 15:15Z.
  const day = "2097-01-15";
  it("starts at 6:00 ET, not 6:00 EDT", () => {
    expect(decidePlutoReadinessRun(new Date("2097-01-15T10:59:59Z"), day, null)).toBeNull();
    expect(decidePlutoReadinessRun(new Date("2097-01-15T11:00:00Z"), day, null)).toBe("first");
  });
  it("runs the final at 9:20 ET and stops offering it at 10:15 ET", () => {
    expect(decidePlutoReadinessRun(new Date("2097-01-15T14:19:59Z"), day, record(day, { signature: "Pluto running", lastRunAt: "2097-01-15T14:00:00.000Z" }))).toBe("recheck");
    expect(decidePlutoReadinessRun(new Date("2097-01-15T14:20:00Z"), day, record(day))).toBe("final");
    expect(decidePlutoReadinessRun(new Date("2097-01-15T15:14:59Z"), day, record(day))).toBe("final");
    expect(decidePlutoReadinessRun(new Date("2097-01-15T15:15:00Z"), day, record(day))).toBeNull();
  });
  it("goes straight to the final when the agent boots between 9:20 and 10:15 ET with no run today", () => {
    expect(decidePlutoReadinessRun(new Date("2097-01-15T14:30:00Z"), day, null)).toBe("final");
  });
});

describe("evaluatePlutoRunning wording (audit)", () => {
  it("names a tripped breaker with spaces, and falls back to 'paused' for an unknown or missing reason", () => {
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "breaker:fill_slippage" }).detail).toBe("paused, the fill slippage breaker is tripped");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "something_new" }).detail).toBe("paused");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: null }).detail).toBe("paused");
  });
  it("treats any mode other than on as switched off", () => {
    expect(evaluatePlutoRunning({ mode: "paper", paused: false, pauseReason: null })).toEqual({ name: "Pluto running", ok: false, detail: "switched off" });
  });
  it("is the fourth named test", () => {
    expect(plutoReadinessTestNames).toEqual(["IBKR", "API sign-in", "OpenRouter", "Pluto running"]);
  });
});

describe("describePlutoReadinessOutcome transitions involving Pluto running (audit)", () => {
  const notRunning = failed("Pluto running", "switched off");
  it("posts a change when a probe starts failing on an Off Pluto, still without a pause promise", () => {
    const outcome = describePlutoReadinessOutcome("recheck", "Pluto running", [failed("IBKR"), ok("API sign-in"), ok("OpenRouter"), notRunning]);
    expect(outcome.signature).toBe("IBKR|Pluto running");
    expect(outcome.message).toContain("Pluto pre-open check changed");
    expect(outcome.message).not.toContain("Pluto pauses at");
    expect(outcome.pause).toBe(false);
  });
  it("adds the pause promise once Pluto is switched on while a probe still fails", () => {
    const outcome = describePlutoReadinessOutcome("recheck", "IBKR|Pluto running", [failed("IBKR"), ok("API sign-in"), ok("OpenRouter"), ok("Pluto running")]);
    expect(outcome.signature).toBe("IBKR");
    expect(outcome.message).toContain("Pluto pauses at 9:20 ET if it still fails");
  });
  it("stays quiet when only the reason Pluto is not running changes (paused -> off)", () => {
    const outcome = describePlutoReadinessOutcome("recheck", "Pluto running", [ok("IBKR"), ok("API sign-in"), ok("OpenRouter"), failed("Pluto running", "switched off and paused by a person")]);
    expect(outcome.message).toBeNull();
  });
  it("lists failures before passes in the message, whatever order the results come in", () => {
    const outcome = describePlutoReadinessOutcome("first", null, [ok("IBKR"), ok("API sign-in"), ok("OpenRouter"), notRunning]);
    const lines = outcome.message!.split("\n");
    expect(lines[1]).toBe("❌ Pluto running: switched off");
    expect(lines.slice(2, 5).every((line) => line.startsWith("✅"))).toBe(true);
  });
  it("builds the signature from failing names in result order", () => {
    expect(plutoReadinessSignature([failed("OpenRouter"), ok("IBKR"), notRunning])).toBe("OpenRouter|Pluto running");
    expect(plutoReadinessSignature([ok("IBKR")])).toBe("");
  });
});
