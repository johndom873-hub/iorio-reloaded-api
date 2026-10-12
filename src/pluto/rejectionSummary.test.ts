import { describe, expect, it } from "vitest";
import { countPlutoRejections, summarizeTickerRejections } from "./rejectionSummary.js";
import type { PlutoTickerFilterResult } from "./candidateFilters.js";

describe("countPlutoRejections", () => {
  it("counts every rule a contract fails, and separately the contracts out on one rule alone", () => {
    const counts = countPlutoRejections([
      { id: "a", reasons: ["grade weak below good"], codes: ["grade"] },
      { id: "b", reasons: ["grade avoid below good", "Edge Yield 2% below 15%"], codes: ["grade", "edge_yield"] },
      { id: "c", reasons: ["annualized yield 20% below 50%"], codes: ["yield"] },
    ]);
    expect(counts.rejectedBy).toEqual({ grade: 2, edge_yield: 1, yield: 1 });
    expect(counts.onlyBlocker).toEqual({ grade: 1, yield: 1 });
  });
  it("a rule failed twice by one contract (a roll's own rule and its replacement's) counts once, and still alone", () => {
    const counts = countPlutoRejections([{ id: "r", reasons: ["roll grade weak below good", "replacement: same contract: held"], codes: ["same_contract", "same_contract"] }]);
    expect(counts).toEqual({ rejectedBy: { same_contract: 1 }, onlyBlocker: { same_contract: 1 } });
  });
});

describe("summarizeTickerRejections", () => {
  const base: PlutoTickerFilterResult = { symbol: "SMCI", tickerBlocks: [], heldShareCall: null, eligible: [], eligibleRolls: [], rejected: [{ id: "a", reasons: ["quote 12 min old (snapshot), max 10"], codes: ["quote_age"] }], rejectedRolls: [] };
  it("keeps the event's symbol, blocks and rejected count, and adds rolls only when some were rejected", () => {
    expect(summarizeTickerRejections(base)).toEqual({ symbol: "SMCI", blocks: [], rejected: 1, rejectedBy: { quote_age: 1 }, onlyBlocker: { quote_age: 1 } });
    const withRolls = summarizeTickerRejections({ ...base, rejectedRolls: [{ id: "r", reasons: ["net roll Edge Yield 4% below 15%"], codes: ["edge_yield"] }] });
    expect(withRolls.rolls).toEqual({ rejected: 1, rejectedBy: { edge_yield: 1 }, onlyBlocker: { edge_yield: 1 } });
  });
  it("a blocked ticker reports its blocks and no counts", () => {
    expect(summarizeTickerRejections({ ...base, tickerBlocks: ["forecast window is 21 days, not the 63-day one"], rejected: [] })).toEqual({ symbol: "SMCI", blocks: ["forecast window is 21 days, not the 63-day one"], rejected: 0, rejectedBy: {}, onlyBlocker: {} });
  });
});
