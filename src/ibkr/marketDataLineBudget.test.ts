import { describe, expect, it } from "vitest";
import { computeAvailableLines, describeMarketDataLineShortage, totalMarketDataLineBudget } from "./marketDataLineBudget.js";

describe("computeAvailableLines", () => {
  it("gives a non-priority holder what is left after both priority and other holders", () => {
    expect(computeAvailableLines({ priorityInUse: 0, otherInUse: 0 }, false)).toBe(totalMarketDataLineBudget);
    expect(computeAvailableLines({ priorityInUse: 50, otherInUse: 25 }, false)).toBe(15);
    expect(computeAvailableLines({ priorityInUse: 50, otherInUse: 60 }, false)).toBe(0);
  });

  it("lets a priority holder ignore non-priority usage entirely", () => {
    expect(computeAvailableLines({ priorityInUse: 0, otherInUse: 85 }, true)).toBe(totalMarketDataLineBudget);
    expect(computeAvailableLines({ priorityInUse: 50, otherInUse: 85 }, true)).toBe(40);
  });

  it("never goes negative", () => {
    expect(computeAvailableLines({ priorityInUse: 100, otherInUse: 100 }, true)).toBe(0);
  });
});

describe("describeMarketDataLineShortage", () => {
  it("names the scheduled scan when a priority reservation is the reason", () => {
    const message = describeMarketDataLineShortage({ ok: false, availableLines: 12, priorityLinesHeld: 50 }, "AAOI", 40);
    expect(message).toContain("scheduled scan");
    expect(message).toContain("50 lines reserved");
    expect(message).toContain("AAOI needs 40 lines, 12 available");
  });

  it("falls back to the plain busy message otherwise", () => {
    const message = describeMarketDataLineShortage({ ok: false, availableLines: 3, priorityLinesHeld: 0 }, "AAOI", 40);
    expect(message).not.toContain("scheduled scan");
    expect(message).toContain("only 3 available");
  });

  it("says so when lines are disabled by the environment switch", () => {
    const message = describeMarketDataLineShortage({ ok: false, availableLines: 0, priorityLinesHeld: 0, disabled: true }, "AAOI", 40);
    expect(message).toContain("IBKR_MARKET_DATA_LINES_ENABLED=false");
  });
});
