import { describe, expect, it } from "vitest";
import { ladderRungReached } from "./backtestBaselineLadder.js";

describe("the rung a ladder put reaches", () => {
  it("counts the reserve's slices it fills up to, rounded up to its rung", () => {
    // R0 $51,298 in 2 rungs, $11,305 committed before it: (11,305 + 25,649) ÷ 25,649 = 1.44 slices, rung 2.
    const reached = ladderRungReached({ committed: 11_305, rungCollateral: 25_649, reserve: 51_298, rungs: 2 });
    expect(reached?.rungNumber).toBe(2);
    expect(reached?.slices).toBeCloseTo(1.4408, 4);
    expect(ladderRungReached({ committed: 0, rungCollateral: 20_000, reserve: 100_000, rungs: 5 })).toEqual({ rungNumber: 1, slices: 1 });
    expect(ladderRungReached({ committed: 40_000, rungCollateral: 20_000, reserve: 100_000, rungs: 5 })).toEqual({ rungNumber: 3, slices: 3 });
  });

  it("keeps a hair over a whole slice on it, stays within 1 to the rungs, and has none without a reserve", () => {
    expect(ladderRungReached({ committed: 20_000.4, rungCollateral: 20_000, reserve: 100_000, rungs: 5 })?.rungNumber).toBe(2);
    expect(ladderRungReached({ committed: 0, rungCollateral: 0, reserve: 100_000, rungs: 5 })?.rungNumber).toBe(1);
    expect(ladderRungReached({ committed: 110_000, rungCollateral: 0, reserve: 100_000, rungs: 5 })?.rungNumber).toBe(5);
    expect(ladderRungReached({ committed: 0, rungCollateral: 0, reserve: 0, rungs: 5 })).toBeNull();
  });
});
