import { describe, expect, it } from "vitest";
import { easternInstant } from "../lib/easternIsoDate.js";
import { decidePlutoReadinessRun, describePlutoReadinessOutcome, evaluatePlutoRunning, plutoReadinessSignature, reusableProbeResults, type PlutoReadinessRecord, type PlutoReadinessResult } from "./readiness.js";

// Audit (area A, 2026-10-07): the "Pluto running" test and its effect on the re-check cadence and the final verdict.

const today = "2026-10-07";
const probesOk: PlutoReadinessResult[] = [
  { name: "IBKR", ok: true, detail: "ok" },
  { name: "API sign-in", ok: true, detail: "ok" },
  { name: "OpenRouter", ok: true, detail: "ok" },
];

describe("Pluto running test in the readiness cycle (audit A)", () => {
  it("a Pluto that is merely off is re-checked every 10 minutes from its state alone: the passing probes are reused, not re-run", () => {
    const results = [...probesOk, evaluatePlutoRunning({ mode: "off", paused: false, pauseReason: null })];
    const signature = plutoReadinessSignature(results);
    expect(signature).toBe("Pluto running");
    const record: PlutoReadinessRecord = { dateIso: today, lastRunAt: easternInstant(today, 6, 0).toISOString(), lastRunKind: "first", signature, finalDone: false, results };
    expect(decidePlutoReadinessRun(easternInstant(today, 6, 10), today, record)).toBe("recheck");
    expect(reusableProbeResults("recheck", record)).toEqual(probesOk);
    expect(describePlutoReadinessOutcome("recheck", signature, results)).toEqual({ signature, message: null, pause: false });
    // Switched on before 9:20: the cheap re-check sees it and says so.
    const nowRunning = [...probesOk, evaluatePlutoRunning({ mode: "on", paused: false, pauseReason: null })];
    expect(describePlutoReadinessOutcome("recheck", signature, nowRunning).message).toContain("passes again");
  });

  it("probes run again on the first and final runs, and on a re-check when a probe itself failed", () => {
    const failingProbe = [{ name: "IBKR" as const, ok: false, detail: "no answer" }, ...probesOk.slice(1), evaluatePlutoRunning({ mode: "off", paused: false, pauseReason: null })];
    const record: PlutoReadinessRecord = { dateIso: today, lastRunAt: easternInstant(today, 6, 0).toISOString(), lastRunKind: "first", signature: plutoReadinessSignature(failingProbe), finalDone: false, results: failingProbe };
    expect(reusableProbeResults("recheck", record)).toBeNull();
    const offOnly: PlutoReadinessRecord = { ...record, results: [...probesOk, evaluatePlutoRunning({ mode: "off", paused: false, pauseReason: null })] };
    expect(reusableProbeResults("final", offOnly)).toBeNull();
    expect(reusableProbeResults("first", null)).toBeNull();
  });

  it("a tripped breaker is named in plain words, and never causes a second pause", () => {
    const running = evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "breaker:daily_loss" });
    expect(running).toEqual({ name: "Pluto running", ok: false, detail: "paused, the daily loss breaker is tripped" });
    const outcome = describePlutoReadinessOutcome("final", "Pluto running", [...probesOk, running]);
    expect(outcome.pause).toBe(false);
    expect(outcome.message).toContain("Pluto is not running at the 9:20 ET check");
  });

  it("an unknown pause reason falls back to 'paused'", () => {
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: null }).detail).toBe("paused");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "something_new" }).detail).toBe("paused");
  });

  it("the re-check note promises a pause only when a probe fails on a running Pluto", () => {
    const failing = [{ name: "IBKR" as const, ok: false, detail: "no answer" }, ...probesOk.slice(1)];
    const running = evaluatePlutoRunning({ mode: "on", paused: false, pauseReason: null });
    expect(describePlutoReadinessOutcome("first", null, [...failing, running]).message).toContain("Pluto pauses at 9:20 ET if it still fails.");
    const off = evaluatePlutoRunning({ mode: "off", paused: false, pauseReason: null });
    expect(describePlutoReadinessOutcome("first", null, [...failing, off]).message).not.toContain("Pluto pauses");
  });
});
