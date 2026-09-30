import { describe, expect, it } from "vitest";
import { buildSurfaceFitFailureMessage } from "./runOptionSurfaceFitJob.js";
import type { SurfaceFitRunEvent } from "./optionSurfaceStore.js";

const fitted = (symbol: string): SurfaceFitRunEvent => ({ symbol, outcome: "fitted", detail: "3/3 expiries ok" });
const skipped = (symbol: string, skipReason: string): SurfaceFitRunEvent => ({ symbol, outcome: "skipped", detail: `skipped: ${skipReason}`, skipReason });

describe("buildSurfaceFitFailureMessage", () => {
  it("is undefined when every ticker was fitted", () => {
    expect(buildSurfaceFitFailureMessage([fitted("AAA"), fitted("BBB")], 2, "2026-10-01")).toBeUndefined();
  });

  it("reports that there was nothing to fit (no usable snapshot for the date), instead of a silent success", () => {
    expect(buildSurfaceFitFailureMessage([], 0, "2026-10-01")).toBe("no complete or partial snapshots found for 2026-10-01, so no surfaces were fitted");
  });

  it("groups skipped tickers by reason", () => {
    const events = [skipped("AAA", "no_risk_free_rate"), fitted("BBB"), skipped("CCC", "no_risk_free_rate"), skipped("DDD", "no_quotes")];
    expect(buildSurfaceFitFailureMessage(events, 4, "2026-10-01")).toBe("3 of 4 tickers not fitted, no_risk_free_rate (AAA, CCC); no_quotes (DDD)");
  });

  it("reports a ticker whose fit threw", () => {
    const events: SurfaceFitRunEvent[] = [{ symbol: "AAA", outcome: "error", detail: "database is locked" }, fitted("BBB")];
    expect(buildSurfaceFitFailureMessage(events, 2, "2026-10-01")).toBe("1 of 2 tickers not fitted, error - database is locked (AAA)");
  });

  it("never contains the '): ' sequence that truncates the Telegram alert", () => {
    expect(buildSurfaceFitFailureMessage([skipped("AAA", "no_risk_free_rate")], 1, "2026-10-01")).not.toContain("): ");
  });
});
