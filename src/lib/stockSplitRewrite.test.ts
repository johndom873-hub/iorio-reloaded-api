import { describe, expect, it } from "vitest";
import { planSplitRecordRewrite, type IbkrHeldSnapshot, type SplitLegRow } from "./stockSplitRewrite.js";
import { describeSplitRatio } from "./stockSplits.js";

const leg = (overrides: Partial<SplitLegRow>): SplitLegRow => ({
  id: "leg",
  positionId: "pos",
  legType: "stock",
  side: "long",
  quantity: 300,
  optionType: null,
  strike: null,
  expiryDateIso: null,
  multiplier: 1,
  ibkrContractId: "111",
  entryPrice: 100,
  exitPrice: null,
  exitedBeforeSplit: false,
  isOpen: true,
  ...overrides,
});
const stockHeld = (quantity: number, avgCost: number): IbkrHeldSnapshot => ({ conId: 111, secType: "STK", right: null, strike: null, expiry: null, multiplier: null, quantity, avgCost });
const optionHeld = (overrides: Partial<IbkrHeldSnapshot>): IbkrHeldSnapshot => ({ conId: 900, secType: "OPT", right: "P", strike: 45, expiry: "20261219", multiplier: "100", quantity: -6, avgCost: 100, ...overrides });
const valueOf = (plan: ReturnType<typeof planSplitRecordRewrite>, rowId: string, column: string) => plan.changes.find((change) => change.rowId === rowId && change.columnName === column)?.newValue;

describe("planSplitRecordRewrite", () => {
  it("moves a 2-for-1's shares, Puts and fills to the new basis with the dollars unchanged", () => {
    const plan = planSplitRecordRewrite({
      splitId: "split",
      symbol: "SMCI",
      ratio: 2,
      effectiveDateIso: "2026-12-01",
      legs: [
        leg({ id: "stock" }),
        leg({ id: "put", legType: "option", side: "short", quantity: 3, optionType: "put", strike: 90, expiryDateIso: "2026-12-19", multiplier: 100, ibkrContractId: "500", entryPrice: 2 }),
        leg({ id: "expired", legType: "option", side: "short", quantity: 3, optionType: "put", strike: 95, expiryDateIso: "2026-11-21", multiplier: 100, ibkrContractId: "400", entryPrice: 1.5, exitPrice: 0, exitedBeforeSplit: true, isOpen: false }),
      ],
      trades: [
        { id: "buy", legId: "stock", quantity: 300, price: 100 },
        { id: "sell-put", legId: "put", quantity: 3, price: 2 },
      ],
      ibkrHoldings: [stockHeld(600, 50), optionHeld({})],
    });
    expect(plan.problems).toEqual([]);
    expect(plan.description).toBe("2-for-1 stock split");
    expect([valueOf(plan, "stock", "quantity"), valueOf(plan, "stock", "entry_price")]).toEqual(["600", "50"]);
    expect([valueOf(plan, "put", "quantity"), valueOf(plan, "put", "strike_price"), valueOf(plan, "put", "entry_price"), valueOf(plan, "put", "multiplier")]).toEqual(["6", "45", "1", undefined]);
    expect(valueOf(plan, "put", "ibkr_contract_id")).toBe("900");
    expect([valueOf(plan, "expired", "quantity"), valueOf(plan, "expired", "strike_price"), valueOf(plan, "expired", "exit_price")]).toEqual(["6", "47.5", undefined]);
    expect([valueOf(plan, "buy", "quantity"), valueOf(plan, "buy", "price"), valueOf(plan, "sell-put", "quantity"), valueOf(plan, "sell-put", "price")]).toEqual(["600", "50", "6", "1"]);
    expect(plan.holdingsComparison.every((line) => line.startsWith("✅"))).toBe(true);
  });

  it("keeps a 3-for-2's contracts and makes each deliver 150 shares", () => {
    const plan = planSplitRecordRewrite({
      splitId: "split",
      symbol: "XYZ",
      ratio: 1.5,
      effectiveDateIso: "2026-12-01",
      legs: [leg({ quantity: 200, entryPrice: 90 }), leg({ id: "call", legType: "option", side: "short", quantity: 2, optionType: "call", strike: 99, expiryDateIso: "2026-12-19", multiplier: 100, entryPrice: 1.2 })],
      trades: [],
      ibkrHoldings: [stockHeld(300, 60), optionHeld({ right: "C", strike: 66, quantity: -2, multiplier: "150" })],
    });
    expect(plan.description).toBe("3-for-2 stock split");
    expect(plan.problems).toEqual([]);
    expect([valueOf(plan, "call", "quantity"), valueOf(plan, "call", "strike_price"), valueOf(plan, "call", "multiplier"), valueOf(plan, "call", "entry_price")]).toEqual([undefined, "66", "150", "0.8"]);
    expect(plan.notes.some((note) => note.includes("150 shares per contract"))).toBe(true);
  });

  it("makes a 1-for-10 reverse split's contracts deliver 10 shares", () => {
    const plan = planSplitRecordRewrite({
      splitId: "split",
      symbol: "XYZ",
      ratio: 0.1,
      effectiveDateIso: "2026-12-01",
      legs: [leg({ quantity: 1000, entryPrice: 2 }), leg({ id: "put", legType: "option", side: "short", quantity: 10, optionType: "put", strike: 2, expiryDateIso: "2026-12-19", multiplier: 100, entryPrice: 0.1 })],
      trades: [],
      ibkrHoldings: [stockHeld(100, 20), optionHeld({ strike: 20, quantity: -10, multiplier: "10" })],
    });
    expect(plan.description).toBe("1-for-10 reverse split");
    expect(plan.problems).toEqual([]);
    expect([valueOf(plan, "leg", "quantity"), valueOf(plan, "leg", "entry_price")]).toEqual(["100", "20"]);
    expect([valueOf(plan, "put", "quantity"), valueOf(plan, "put", "strike_price"), valueOf(plan, "put", "multiplier"), valueOf(plan, "put", "entry_price")]).toEqual([undefined, "20", "10", "1"]);
  });

  it("stops on a fraction of a share and on holdings IBKR does not show", () => {
    const fractional = planSplitRecordRewrite({ splitId: "s", symbol: "XYZ", ratio: 0.1, effectiveDateIso: "2026-12-01", legs: [leg({ quantity: 105 })], trades: [], ibkrHoldings: [stockHeld(10, 20)] });
    expect(fractional.problems.some((problem) => problem.includes("not a whole number"))).toBe(true);
    const mismatch = planSplitRecordRewrite({ splitId: "s", symbol: "XYZ", ratio: 2, effectiveDateIso: "2026-12-01", legs: [leg({})], trades: [], ibkrHoldings: [stockHeld(300, 100)] });
    expect(mismatch.problems).toEqual(["Shares after the rewrite (600) differ from IBKR's (300)."]);
    const noHoldings = planSplitRecordRewrite({ splitId: "s", symbol: "XYZ", ratio: 2, effectiveDateIso: "2026-12-01", legs: [leg({})], trades: [], ibkrHoldings: null });
    expect(noHoldings.problems[0]).toContain("has not kept IBKR's holdings");
  });
});

describe("describeSplitRatio", () => {
  it("says the split as people do", () => {
    expect([2, 3, 1.5, 0.1, 0.2, 4 / 3].map(describeSplitRatio)).toEqual(["2-for-1 stock split", "3-for-1 stock split", "3-for-2 stock split", "1-for-10 reverse split", "1-for-5 reverse split", "4-for-3 stock split"]);
  });
});
