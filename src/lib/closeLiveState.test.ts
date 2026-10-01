import { describe, expect, it } from "vitest";
import { deriveCloseLiveState, type CloseLiveLeg, type DeriveCloseLiveStateInput } from "./closeLiveState.js";
import type { CycleInput } from "./cycles.js";

const stockLeg: CloseLiveLeg = { id: "stock-leg", legType: "stock", side: "long", quantity: 100, multiplier: 1, entryPrice: 50, label: "ABC stock" };
const shortCallLeg: CloseLiveLeg = { id: "call-leg", legType: "option", side: "short", quantity: 1, multiplier: 100, entryPrice: 2, label: "$55C 2026-10-16" };

// 100 shares bought at 50 on 2026-09-01, marked at 55 on the last daily bar (so the stored mark is +500).
function bareStockCycleInput(overrides: Partial<CycleInput> = {}): CycleInput {
  return {
    optionLegs: [],
    stockLegs: [{ positionId: "pos-1", quantity: 100, entryAt: new Date("2026-09-01T15:00:00Z"), exitAt: null }],
    stockTrades: [{ at: new Date("2026-09-01T15:00:00Z"), side: "buy", quantity: 100, price: 50, commission: 0 }],
    dailyCloses: new Map([["2026-09-25", 55]]),
    lastPrice: { date: "2026-09-25", price: 55 },
    openPositionPremiumPnl: new Map(),
    ...overrides,
  };
}

// The same shares plus a short call opened with them (a covered call), sold at 2.00.
function coveredCallCycleInput(): CycleInput {
  return bareStockCycleInput({
    optionLegs: [
      {
        id: "call-leg", positionId: "pos-1", side: "short", optionType: "call", strike: 55, quantity: 1, multiplier: 100, entryPrice: 2,
        entryAt: new Date("2026-09-01T15:00:00Z"), exitPrice: null, exitAt: null, closingCommission: 0, hasClosingTrade: false,
        expiryDate: "2026-10-16", expiryClose: null,
      },
    ],
  });
}

function stateFor(overrides: Partial<DeriveCloseLiveStateInput> = {}) {
  return deriveCloseLiveState({
    symbol: "ABC",
    positionId: "pos-1",
    legs: [stockLeg],
    marketState: "open",
    optionQuotesByLegId: {},
    stockQuote: { bid: 59.9, ask: 60.1, last: 60 },
    cycleInput: bareStockCycleInput(),
    todayIso: "2026-09-28",
    waitedMs: 10_000,
    settleGraceMs: 3_000,
    ...overrides,
  });
}

describe("deriveCloseLiveState", () => {
  it("is live for a bare-stock position and marks the cycle at the live last, not the daily close", () => {
    const state = stateFor();
    expect(state.live).toBe(true);
    expect(state.blockReason).toBeNull();
    // 100 sh x (60 live - 50 cost) = 1000, where the stored close mark of 55 would have given 500.
    expect(state.cycleTotal).toBeCloseTo(1000);
    expect(state.legQuotes["stock-leg"]).toEqual({ bid: 59.9, ask: 60.1, last: 60, mid: 60 });
  });

  it("blocks with the session named when the market is not in its regular session", () => {
    for (const [marketState, wording] of [["closed", "closed"], ["pre-market", "in pre-market"], ["after-hours", "in after-hours trading"]] as const) {
      const state = stateFor({ marketState });
      expect(state.live).toBe(false);
      expect(state.marketOpen).toBe(false);
      expect(state.cycleTotal).toBeNull();
      expect(state.blockReason).toContain(`The market is ${wording} right now.`);
    }
  });

  it("does not treat the pool's daily-close fallback (a last with no bid/ask) as live", () => {
    const state = stateFor({ stockQuote: { bid: null, ask: null, last: 55 } });
    expect(state.live).toBe(false);
    expect(state.cycleTotal).toBeNull();
  });

  it("waits during the settle grace, then reports the missing quote as unavailable", () => {
    const missing = { stockQuote: { bid: null, ask: null, last: null } };
    const waiting = stateFor({ ...missing, waitedMs: 1_000 });
    expect(waiting).toMatchObject({ live: false, pending: true, blockReason: "Waiting for live quotes…" });
    const unavailable = stateFor({ ...missing, waitedMs: 3_500 });
    expect(unavailable.pending).toBe(false);
    expect(unavailable.blockReason).toBe("Live bid/ask is unavailable for ABC stock. Closing needs live prices.");
  });

  it("rejects a crossed or zero-ask market", () => {
    expect(stateFor({ stockQuote: { bid: 60.2, ask: 60.1, last: 60 } }).live).toBe(false);
    expect(stateFor({ stockQuote: { bid: 0, ask: 0, last: 60 } }).live).toBe(false);
  });

  it("blocks on a flagged cycle and says why", () => {
    // The ledger holds 100 sh but the stock legs total 200 sh.
    const flagged = bareStockCycleInput({
      stockLegs: [
        { positionId: "pos-1", quantity: 100, entryAt: new Date("2026-09-01T15:00:00Z"), exitAt: null },
        { positionId: "pos-1", quantity: 100, entryAt: new Date("2026-09-01T15:00:00Z"), exitAt: null },
      ],
    });
    const state = stateFor({ cycleInput: flagged });
    expect(state.live).toBe(false);
    expect(state.cycleTotal).toBeNull();
    expect(state.blockReason).toContain("ABC wheel cycle has inconsistent data");
    expect(state.blockReason).toContain("the open stock legs total 200 sh");
  });

  it("blocks when the ticker has no open cycle", () => {
    const state = stateFor({ cycleInput: bareStockCycleInput({ stockLegs: [], stockTrades: [] }), legs: [] });
    expect(state.live).toBe(false);
    expect(state.blockReason).toContain("No open wheel cycle was found for ABC");
  });

  describe("hedge (long call)", () => {
    const longCallLeg: CloseLiveLeg = { id: "hedge-leg", legType: "option", side: "long", quantity: 2, multiplier: 100, entryPrice: 4, label: "$82C 2028-06-16" };
    const hedgeCycleInput = (): CycleInput => ({
      optionLegs: [
        {
          id: "hedge-leg", positionId: "pos-hedge", side: "long", optionType: "call", strike: 82, quantity: 2, multiplier: 100, entryPrice: 4,
          entryAt: new Date("2026-09-20T15:00:00Z"), exitPrice: null, exitAt: null, closingCommission: 0, hasClosingTrade: false, expiryDate: "2028-06-16", expiryClose: null,
        },
      ],
      stockLegs: [],
      stockTrades: [],
      dailyCloses: new Map([["2026-09-25", 80]]),
      lastPrice: { date: "2026-09-25", price: 80 },
      openPositionPremiumPnl: new Map(),
    });

    it("closes against its own hedge cycle and marks the long call at the live mid", () => {
      const state = stateFor({ positionId: "pos-hedge", legs: [longCallLeg], cycleInput: hedgeCycleInput(), stockQuote: null, optionQuotesByLegId: { "hedge-leg": { bid: 4.9, ask: 5.1, last: 5 } } });
      expect(state.blockReason).toBeNull();
      // Bought at 4.00, now mid 5.00: (5 - 4) x 2 x 100 = +200 on the hedge cycle (premium -800, mark adjustment +1000).
      expect(state.cycleTotal).toBeCloseTo(200);
    });
  });

  describe("covered call (stock + short call)", () => {
    const legs = [stockLeg, shortCallLeg];

    it("marks the short call at the live bid/ask mid and the shares at the live last", () => {
      const state = stateFor({ legs, cycleInput: coveredCallCycleInput(), optionQuotesByLegId: { "call-leg": { bid: 0.9, ask: 1.1, last: 5 } } });
      expect(state.live).toBe(true);
      // Stock +1000; call sold at 2.00 and now worth mid 1.00 -> premium P&L (2.00 - 1.00) x 100 = +100 (the stale `last` of 5 is ignored).
      expect(state.cycleTotal).toBeCloseTo(1100);
      expect(state.legQuotes["call-leg"]!.mid).toBeCloseTo(1);
    });

    it("moves against the position when the call gains value", () => {
      const state = stateFor({ legs, cycleInput: coveredCallCycleInput(), optionQuotesByLegId: { "call-leg": { bid: 5.9, ask: 6.1, last: 6 } } });
      // Call now costs 6.00 to buy back: premium P&L (2.00 - 6.00) x 100 = -400, stock +1000.
      expect(state.cycleTotal).toBeCloseTo(600);
    });

    it("blocks until the option has a live bid/ask, naming the leg", () => {
      const state = stateFor({ legs, cycleInput: coveredCallCycleInput(), optionQuotesByLegId: { "call-leg": { bid: null, ask: null, last: 1 } } });
      expect(state.live).toBe(false);
      expect(state.blockReason).toBe("Live bid/ask is unavailable for $55C 2026-10-16. Closing needs live prices.");
    });

    it("accepts a worthless option with a zero bid", () => {
      const state = stateFor({ legs, cycleInput: coveredCallCycleInput(), optionQuotesByLegId: { "call-leg": { bid: 0, ask: 0.05, last: 0.02 } } });
      expect(state.live).toBe(true);
    });
  });

  it("still needs the stock quote for an option-only position when the ticker's cycle holds shares", () => {
    const state = stateFor({
      legs: [shortCallLeg],
      cycleInput: coveredCallCycleInput(),
      optionQuotesByLegId: { "call-leg": { bid: 0.9, ask: 1.1, last: 1 } },
      stockQuote: null,
    });
    expect(state.live).toBe(false);
    expect(state.blockReason).toBe("Live bid/ask is unavailable for ABC stock. Closing needs live prices.");
  });
});
