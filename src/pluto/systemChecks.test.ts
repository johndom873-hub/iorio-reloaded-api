import { describe, expect, it } from "vitest";
import { dailyLossPercent, evaluateReconciliationCheck, isInsideTradingWindow } from "./systemChecks.js";

describe("isInsideTradingWindow", () => {
  const today = "2026-09-28"; // EDT, UTC-4
  it("is inside between start (inclusive) and end (exclusive) on Eastern clock time", () => {
    expect(isInsideTradingWindow(new Date("2026-09-28T14:44:59Z"), today, "10:45", "15:30")).toBe(false); // 10:44:59 ET
    expect(isInsideTradingWindow(new Date("2026-09-28T14:45:00Z"), today, "10:45", "15:30")).toBe(true); // 10:45 ET
    expect(isInsideTradingWindow(new Date("2026-09-28T19:29:59Z"), today, "10:45", "15:30")).toBe(true); // 15:29:59 ET
    expect(isInsideTradingWindow(new Date("2026-09-28T19:30:00Z"), today, "10:45", "15:30")).toBe(false); // 15:30 ET
  });
  it("follows the Eastern offset in winter", () => {
    expect(isInsideTradingWindow(new Date("2026-12-15T15:45:00Z"), "2026-12-15", "10:45", "15:30")).toBe(true); // 10:45 EST
    expect(isInsideTradingWindow(new Date("2026-12-15T14:45:00Z"), "2026-12-15", "10:45", "15:30")).toBe(false); // 09:45 EST
  });
});

describe("dailyLossPercent", () => {
  it("is today's NLV move against the previous snapshot, null when either side is missing", () => {
    expect(dailyLossPercent(980_000, 1_000_000)).toBeCloseTo(-2, 10);
    expect(dailyLossPercent(1_010_000, 1_000_000)).toBeCloseTo(1, 10);
    expect(dailyLossPercent(null, 1_000_000)).toBeNull();
    expect(dailyLossPercent(980_000, null)).toBeNull();
    expect(dailyLossPercent(980_000, 0)).toBeNull();
  });
});

describe("evaluateReconciliationCheck", () => {
  const now = new Date("2026-09-29T15:00:00Z");
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it("fails closed when there is no successful run", () => {
    expect(evaluateReconciliationCheck(undefined, now)).toEqual({ ok: false, detail: "no successful health-check run recorded" });
  });
  it("passes on a clean run inside the limit and fails past it", () => {
    expect(evaluateReconciliationCheck({ started_at: minutesAgo(35), details: { reconciliationProblems: [] } }, now).ok).toBe(true);
    expect(evaluateReconciliationCheck({ started_at: minutesAgo(36), details: { reconciliationProblems: [] } }, now)).toEqual({ ok: false, detail: "last successful health check 36 min ago (limit 35)" });
  });
  it("reports a discrepancy with the prefix the breaker trips on", () => {
    const check = evaluateReconciliationCheck({ started_at: minutesAgo(5), details: { reconciliationProblems: ["AAPL: IBKR 100, book 0"] } }, now);
    expect(check).toEqual({ ok: false, detail: "discrepancy: AAPL: IBKR 100, book 0" });
  });
  it("fails without a discrepancy (so no breaker) when reconciliation could not run", () => {
    const check = evaluateReconciliationCheck({ started_at: minutesAgo(5), details: { reconciliationProblems: ["Reconciliation check itself failed: timeout"] } }, now);
    expect(check).toEqual({ ok: false, detail: "reconciliation did not run: Reconciliation check itself failed: timeout" });
  });
  it("fails when a successful run carries no reconciliation result", () => {
    expect(evaluateReconciliationCheck({ started_at: minutesAgo(5), details: null }, now).ok).toBe(false);
    expect(evaluateReconciliationCheck({ started_at: minutesAgo(5), details: {} }, now).detail).toBe("the last successful health check recorded no reconciliation result");
  });
});
