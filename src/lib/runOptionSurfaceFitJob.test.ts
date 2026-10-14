import { describe, expect, it } from "vitest";
import { buildSurfaceFitJobOutcome } from "./runOptionSurfaceFitJob.js";
import type { SurfaceFitRunEvent } from "./optionSurfaceStore.js";

const fitted = (symbol: string): SurfaceFitRunEvent => ({ symbol, outcome: "fitted", detail: "3/3 expiries ok" });
const skipped = (symbol: string, skipReason: string): SurfaceFitRunEvent => ({ symbol, outcome: "skipped", detail: `skipped: ${skipReason}`, skipReason });

describe("buildSurfaceFitJobOutcome", () => {
  it("is neither a failure nor completed with errors when every ticker was fitted", () => {
    expect(buildSurfaceFitJobOutcome([fitted("AAA"), fitted("BBB")], 2, "2026-10-01")).toEqual({});
  });

  it("fails when there was nothing to fit (no usable snapshot for the date), instead of a silent success", () => {
    expect(buildSurfaceFitJobOutcome([], 0, "2026-10-01")).toEqual({ failureMessage: "no complete or partial snapshots found for 2026-10-01, so no surfaces were fitted" });
  });

  it("completes with errors when some tickers were fitted, grouping the others by reason", () => {
    const events = [skipped("AAA", "no_risk_free_rate"), fitted("BBB"), skipped("CCC", "no_risk_free_rate"), skipped("DDD", "no_quotes")];
    expect(buildSurfaceFitJobOutcome(events, 4, "2026-10-01")).toEqual({ completedWithErrors: { errorCount: 3, message: "no_risk_free_rate (AAA, CCC); no_quotes (DDD); 1 of 4 tickers fitted" } });
  });

  it("completes with errors when a ticker's fit threw", () => {
    const events: SurfaceFitRunEvent[] = [{ symbol: "AAA", outcome: "error", detail: "database is locked" }, fitted("BBB")];
    expect(buildSurfaceFitJobOutcome(events, 2, "2026-10-01")).toEqual({ completedWithErrors: { errorCount: 1, message: "error - database is locked (AAA); 1 of 2 tickers fitted" } });
  });

  it("fails when no ticker was fitted", () => {
    const events = [skipped("AAA", "no_risk_free_rate"), skipped("BBB", "no_quotes")];
    expect(buildSurfaceFitJobOutcome(events, 2, "2026-10-01")).toEqual({ failureMessage: "2 of 2 tickers not fitted, no_risk_free_rate (AAA); no_quotes (BBB)" });
  });

  it("never contains the '): ' sequence that truncates the Telegram alert", () => {
    expect(buildSurfaceFitJobOutcome([skipped("AAA", "no_risk_free_rate"), fitted("BBB")], 2, "2026-10-01").completedWithErrors?.message).not.toContain("): ");
  });
});
