import { describe, expect, it } from "vitest";
import { easternInstant } from "../lib/easternIsoDate.js";
import { assemblePlutoReadinessResults, decidePlutoReadinessRun, describePlutoReadinessOutcome, evaluatePlutoRunning, plutoReadinessSignature, reusableProbeResults, type PlutoReadinessRecord, type PlutoReadinessResult } from "./readiness.js";

// Audit (area A, 2026-10-07): the "Pluto running" test and its effect on the re-check cadence and the final verdict.

const today = "2026-10-07";
const probesOk: PlutoReadinessResult[] = [
  { name: "IBKR", ok: true, status: "ok", detail: "ok" },
  { name: "API sign-in", ok: true, status: "ok", detail: "ok" },
];

describe("Pluto running test in the readiness cycle (audit A)", () => {
  it("a switched-off Pluto has no failing test, so it is not re-checked at all", () => {
    const results = assemblePlutoReadinessResults(probesOk, { mode: "off", paused: false, pauseReason: null });
    const record: PlutoReadinessRecord = { dateIso: today, lastRunAt: easternInstant(today, 6, 0).toISOString(), lastRunKind: "first", signature: plutoReadinessSignature(results), finalDone: false, results };
    expect(record.signature).toBe("");
    expect(decidePlutoReadinessRun(easternInstant(today, 6, 10), today, record)).toBeNull();
  });

  it("a Pluto that is merely paused is re-checked every 10 minutes from its state alone: the passing probes are reused, not re-run", () => {
    const results = [...probesOk, evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "deploy" })];
    const signature = plutoReadinessSignature(results);
    expect(signature).toBe("Pluto running");
    const record: PlutoReadinessRecord = { dateIso: today, lastRunAt: easternInstant(today, 6, 0).toISOString(), lastRunKind: "first", signature, finalDone: false, results };
    expect(decidePlutoReadinessRun(easternInstant(today, 6, 10), today, record)).toBe("recheck");
    expect(reusableProbeResults("recheck", record)).toEqual(probesOk);
    expect(describePlutoReadinessOutcome("recheck", signature, results)).toEqual({ signature, message: null, pause: false });
    // Resumed before 9:20: the cheap re-check sees it and says so.
    const nowRunning = [...probesOk, evaluatePlutoRunning({ mode: "on", paused: false, pauseReason: null })];
    expect(describePlutoReadinessOutcome("recheck", signature, nowRunning).message).toContain("passes again");
  });

  it("probes run again on the first and final runs, and on a re-check when a probe itself failed", () => {
    const failingProbe = assemblePlutoReadinessResults([{ name: "IBKR" as const, ok: false, status: "fail", detail: "no answer" }, ...probesOk.slice(1)], { mode: "on", paused: true, pauseReason: "deploy" });
    const record: PlutoReadinessRecord = { dateIso: today, lastRunAt: easternInstant(today, 6, 0).toISOString(), lastRunKind: "first", signature: plutoReadinessSignature(failingProbe), finalDone: false, results: failingProbe };
    expect(reusableProbeResults("recheck", record)).toBeNull();
    const pausedOnly: PlutoReadinessRecord = { ...record, results: [...probesOk, evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "deploy" })] };
    expect(reusableProbeResults("final", pausedOnly)).toBeNull();
    expect(reusableProbeResults("first", null)).toBeNull();
  });

  it("a tripped breaker is named in plain words, and never causes a second pause", () => {
    const running = evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "breaker:daily_loss" });
    expect(running).toEqual({ name: "Pluto running", ok: false, status: "fail", detail: "paused, the daily loss breaker is tripped" });
    const outcome = describePlutoReadinessOutcome("final", "Pluto running", [...probesOk, running]);
    expect(outcome.pause).toBe(false);
    expect(outcome.message).toContain("Pluto is paused at the 9:20 ET check");
  });

  it("an unknown pause reason falls back to 'paused'", () => {
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: null }).detail).toBe("paused");
    expect(evaluatePlutoRunning({ mode: "on", paused: true, pauseReason: "something_new" }).detail).toBe("paused");
  });

  it("the re-check note promises a pause only when a probe fails on a running Pluto", () => {
    const failing: PlutoReadinessResult[] = [{ name: "IBKR", ok: false, status: "fail", detail: "no answer" }, ...probesOk.slice(1)];
    expect(describePlutoReadinessOutcome("first", null, assemblePlutoReadinessResults(failing, { mode: "on", paused: false, pauseReason: null })).message).toContain("Pluto pauses at 9:20 ET if it still fails.");
    expect(describePlutoReadinessOutcome("first", null, assemblePlutoReadinessResults(failing, { mode: "on", paused: true, pauseReason: "manual" })).message).not.toContain("Pluto pauses");
    expect(describePlutoReadinessOutcome("first", null, assemblePlutoReadinessResults(failing, { mode: "off", paused: false, pauseReason: null })).message).not.toContain("Pluto pauses");
  });
});
