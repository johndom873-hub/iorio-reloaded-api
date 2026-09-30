import { describe, expect, it } from "vitest";
import { buildSurfaceFitFailureMessage } from "./runOptionSurfaceFitJob.js";
import type { SurfaceFitRunEvent } from "./optionSurfaceStore.js";

const fitted = (symbol: string): SurfaceFitRunEvent => ({ symbol, outcome: "fitted", detail: "3/3 expiries ok" });
const skipped = (symbol: string, skipReason: string): SurfaceFitRunEvent => ({ symbol, outcome: "skipped", detail: `skipped: ${skipReason}`, skipReason });

describe("buildSurfaceFitFailureMessage", () => {
  it("is undefined when every ticker was fitted", () => {
    expect(buildSurfaceFitFailureMessage([fitted("AAA"), fitted("BBB")], 2)).toBeUndefined();
  });

  it("is undefined when there was nothing to fit", () => {
    expect(buildSurfaceFitFailureMessage([], 0)).toBeUndefined();
  });

  it("groups skipped tickers by reason", () => {
    const events = [skipped("AAA", "no_risk_free_rate"), fitted("BBB"), skipped("CCC", "no_risk_free_rate"), skipped("DDD", "no_quotes")];
    expect(buildSurfaceFitFailureMessage(events, 4)).toBe("3 of 4 tickers not fitted, no_risk_free_rate (AAA, CCC); no_quotes (DDD)");
  });

  it("reports a ticker whose fit threw", () => {
    const events: SurfaceFitRunEvent[] = [{ symbol: "AAA", outcome: "error", detail: "database is locked" }, fitted("BBB")];
    expect(buildSurfaceFitFailureMessage(events, 2)).toBe("1 of 2 tickers not fitted, error - database is locked (AAA)");
  });

  it("never contains the '): ' sequence that truncates the Telegram alert", () => {
    expect(buildSurfaceFitFailureMessage([skipped("AAA", "no_risk_free_rate")], 1)).not.toContain("): ");
  });
});
