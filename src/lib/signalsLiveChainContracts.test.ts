import { describe, expect, it } from "vitest";
import { selectLiveChainContracts, shouldRecenterLiveChain } from "./signalsLiveChainContracts.js";

const expiry = "2026-10-23";
const strikes = Array.from({ length: 41 }, (_, index) => 200 + index * 5); // 200..400
const labels = (contracts: { strike: number; right: string }[]) => contracts.map((contract) => `${contract.strike}${contract.right}`);

describe("selectLiveChainContracts", () => {
  it("takes puts at or below spot and calls at or above, alternately, nearest first", () => {
    const selected = selectLiveChainContracts({ expiry, strikes, spotPrice: 297.73, heldLegs: [], maxContracts: 8 });
    expect(labels(selected)).toEqual(["295P", "300C", "290P", "305C", "285P", "310C", "280P", "315C"]);
  });

  it("caps at 40 by default and never picks an in-the-money contract", () => {
    const selected = selectLiveChainContracts({ expiry, strikes, spotPrice: 297.73, heldLegs: [] });
    expect(selected).toHaveLength(40);
    expect(selected.every((contract) => (contract.right === "P" ? contract.strike <= 297.73 : contract.strike >= 297.73))).toBe(true);
  });

  it("puts open legs first, without duplicating a leg that is also near the spot", () => {
    const selected = selectLiveChainContracts({ expiry, strikes, spotPrice: 297.73, heldLegs: [{ expiry: "2026-10-16", strike: 250, right: "P" }, { expiry, strike: 295, right: "P" }], maxContracts: 5 });
    expect(selected.map((contract) => `${contract.expiry}|${contract.strike}${contract.right}`)).toEqual(["2026-10-16|250P", `${expiry}|295P`, `${expiry}|300C`, `${expiry}|290P`, `${expiry}|305C`]);
  });

  it("keeps filling from the other side when one side of the grid runs out", () => {
    const selected = selectLiveChainContracts({ expiry, strikes: [100, 105, 110, 115, 120], spotPrice: 118, heldLegs: [], maxContracts: 10 });
    expect(labels(selected)).toEqual(["115P", "120C", "110P", "105P", "100P"]);
  });

  it("gives an empty set for an empty grid", () => {
    expect(selectLiveChainContracts({ expiry, strikes: [], spotPrice: 100, heldLegs: [] })).toEqual([]);
  });
});

describe("shouldRecenterLiveChain", () => {
  it("fires once the spot is two strike steps ($5 steps: $10) from the anchor, either way, and not before", () => {
    expect(shouldRecenterLiveChain(277.52, 286, strikes)).toBe(false);
    expect(shouldRecenterLiveChain(277.52, 287.52, strikes)).toBe(true);
    expect(shouldRecenterLiveChain(297.73, 287.7, strikes)).toBe(true);
    expect(shouldRecenterLiveChain(297.73, 288, strikes)).toBe(false);
  });
  it("never fires when the anchor sits outside the grid", () => {
    expect(shouldRecenterLiveChain(500, 900, strikes)).toBe(false);
  });
});
