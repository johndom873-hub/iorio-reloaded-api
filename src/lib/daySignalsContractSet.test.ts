import { describe, expect, it } from "vitest";
import { computeStrikeWindow } from "./optionChainCaptureWindow.js";
import {
  daySignalsRerankTriggerFraction,
  decideRerank,
  selectDaySignalContractSet,
  strikeStepAroundSpot,
  type DayContractRef,
} from "./daySignalsContractSet.js";

const expiry = "2026-10-23";
const strikes = Array.from({ length: 17 }, (_, index) => 250 + index * 5); // 250..330
const windowAt = (spotPrice: number) => computeStrikeWindow({ spotPrice, atmImpliedVolatility: 0.3, daysToExpiry: 24 })!;
const put = (strike: number): DayContractRef => ({ expiry, strike, right: "P" });
const call = (strike: number): DayContractRef => ({ expiry, strike, right: "C" });
const setAt = (spotPrice: number, previousContracts: DayContractRef[] = [], heldContracts: DayContractRef[] = []) =>
  selectDaySignalContractSet({ expiries: [{ expiry, strikes, window: windowAt(spotPrice) }], spotPrice, previousContracts, heldContracts });
const strikesOf = (contracts: DayContractRef[], right: "C" | "P") => contracts.filter((contract) => contract.right === right).map((contract) => contract.strike);

describe("selectDaySignalContractSet", () => {
  it("at the capture spot equals the capture's rule: OTM puts below, OTM calls above, both rights at the nearest strike", () => {
    const contracts = setAt(282);
    expect(strikesOf(contracts, "P").at(-1)).toBe(280);
    expect(strikesOf(contracts, "C")[0]).toBe(280);
    expect(strikesOf(contracts, "P")).not.toContain(285);
  });

  it("follows a rally: puts up to the new spot appear, and ITM calls fall out once past the buffer", () => {
    const first = setAt(282);
    const rallied = setAt(299.73, first);
    expect(strikesOf(rallied, "P")).toEqual(expect.arrayContaining([285, 290, 295, 300]));
    // call 280 sits 19.7 below spot (> one step): dropped. Call 295 is within one step of spot: kept only if it was previous.
    expect(strikesOf(rallied, "C")).not.toContain(280);
    expect(strikesOf(rallied, "C")).not.toContain(285);
  });

  it("keeps a previous contract one strike step past the boundary, and drops it beyond", () => {
    // Spot 301: nearest strike 300, step 5. A put at 305 is ITM by 4 (kept), at 310 by 9 (dropped).
    expect(setAt(301, [put(305)])).toContainEqual(put(305));
    expect(setAt(301, [put(310)])).not.toContainEqual(put(310));
    // Spot 303: nearest strike 305. A call at 300 is ITM by 3 (kept), at 295 by 8 (dropped).
    expect(setAt(303, [call(300)])).toContainEqual(call(300));
    expect(setAt(303, [call(295)])).not.toContainEqual(call(295));
  });

  it("drops far ITM contracts that were captured at the open (the puts and calls now on the wrong side)", () => {
    const rallied = setAt(299.73, setAt(282));
    expect(strikesOf(rallied, "P")).not.toContain(280 + 25); // never stored: far ITM
    expect(strikesOf(rallied, "C")).not.toContain(270);
  });

  it("always includes held contracts of pooled expiries, and ignores held contracts of other expiries", () => {
    const heldFarItm = put(325);
    expect(setAt(299.73, [], [heldFarItm])).toContainEqual(heldFarItm);
    const elsewhere: DayContractRef = { expiry: "2026-12-18", strike: 300, right: "P" };
    expect(setAt(299.73, [], [elsewhere])).not.toContainEqual(elsewhere);
  });

  it("does not resurrect a previous contract that is no longer a listed strike", () => {
    expect(setAt(299.73, [put(302.5)])).not.toContainEqual(put(302.5));
  });

  it("is sorted and free of duplicates", () => {
    const contracts = setAt(299.73, setAt(299.73), [put(300)]);
    const keys = contracts.map((contract) => `${contract.expiry}|${contract.strike}|${contract.right}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(contracts.map((contract) => contract.strike)).toEqual([...contracts.map((contract) => contract.strike)].sort((a, b) => a - b));
  });
});

describe("strikeStepAroundSpot", () => {
  it("is the gap between the strikes straddling spot, null when the grid does not straddle it", () => {
    expect(strikeStepAroundSpot([100, 105, 110], 106)).toBe(5);
    expect(strikeStepAroundSpot([100, 105, 110], 120)).toBeNull();
  });
});

describe("daySignalsRerankTriggerFraction", () => {
  it("is half the one-day expected move, floored at 1%", () => {
    expect(daySignalsRerankTriggerFraction(0.8)).toBeCloseTo(0.5 * 0.8 / Math.sqrt(252), 10); // ~2.52%
    expect(daySignalsRerankTriggerFraction(0.25)).toBe(0.01); // 0.79% floored
  });
});

describe("decideRerank (2026-10-07: 15-minute gap, hourly re-check of unpooled tickers)", () => {
  const now = Date.UTC(2026, 9, 7, 16, 0);
  const minutes = (count: number) => count * 60_000;
  const base = { spotPrice: 100, referenceSpotPrice: 100, atmImpliedVolatility: 0.8, lastLookAtMs: null, firstSeenAtMs: now - minutes(10), pooled: true, nowMs: now };

  it("fires on price at the trigger in either direction and not below it", () => {
    expect(decideRerank({ ...base, spotPrice: 102 })).toBeNull(); // 2% < 2.52%
    expect(decideRerank({ ...base, spotPrice: 102.6 })).toBe("price");
    expect(decideRerank({ ...base, spotPrice: 97.4 })).toBe("price");
  });

  it("has no daily cap, only a 15-minute gap after any look", () => {
    expect(decideRerank({ ...base, spotPrice: 120, lastLookAtMs: now - minutes(14) })).toBeNull();
    expect(decideRerank({ ...base, spotPrice: 120, lastLookAtMs: now - minutes(15) })).toBe("price");
  });

  it("re-checks an unpooled ticker an hour after its last look, or after it was first seen", () => {
    expect(decideRerank({ ...base, pooled: false, firstSeenAtMs: now - minutes(59) })).toBeNull();
    expect(decideRerank({ ...base, pooled: false, firstSeenAtMs: now - minutes(60) })).toBe("timed");
    expect(decideRerank({ ...base, pooled: false, firstSeenAtMs: now - minutes(200), lastLookAtMs: now - minutes(30) })).toBeNull();
    expect(decideRerank({ ...base, pooled: false, lastLookAtMs: now - minutes(61) })).toBe("timed");
    expect(decideRerank({ ...base, pooled: true, lastLookAtMs: now - minutes(120) })).toBeNull(); // pooled tickers are quoted every cycle
  });

  it("prefers the price reason when both apply, and never fires on unusable inputs", () => {
    expect(decideRerank({ ...base, pooled: false, spotPrice: 105, lastLookAtMs: now - minutes(90) })).toBe("price");
    expect(decideRerank({ ...base, spotPrice: 120, atmImpliedVolatility: 0 })).toBeNull();
    expect(decideRerank({ ...base, spotPrice: Number.NaN, pooled: false, lastLookAtMs: now - minutes(90) })).toBeNull();
  });
});
