import { describe, expect, it } from "vitest";
import { summarizeMarketDataLineUsage } from "./marketDataLineBudget.js";

describe("summarizeMarketDataLineUsage", () => {
  it("counts the pool's open lines (not its reservation) plus every other holder, grouped by use", () => {
    const usage = summarizeMarketDataLineUsage(
      [
        { holder: "marketDataPool", lines: 25 },
        { holder: "optionChainCapture", lines: 50 },
        { holder: "snapshot:pricing:AAOI:1", lines: 1 },
        { holder: "snapshot:prices:2", lines: 3 },
      ],
      20,
    );
    expect(usage).toEqual({ inUse: 74, budget: 90, byUse: [{ label: "Screens", lines: 20 }, { label: "Chain capture", lines: 50 }, { label: "Snapshots", lines: 4 }] });
  });

  it("leaves out uses holding nothing, and names an unknown holder by its prefix", () => {
    expect(summarizeMarketDataLineUsage([{ holder: "newJob:x", lines: 2 }], 0)).toEqual({ inUse: 2, budget: 90, byUse: [{ label: "newJob", lines: 2 }] });
  });
});
