import { describe, expect, it } from "vitest";
import type { BacktestCycleTimelineRow } from "./backtestTypes.js";
import { cashBreakEvenBeforeEachRow, cycleCashBreakEven, sharesHeldAfterEachMoment, sharesHeldAtInstant } from "./cycleCashBreakEven.js";

const row = (overrides: Partial<BacktestCycleTimelineRow>): BacktestCycleTimelineRow => ({
  at: "2026-09-01T14:00:00.000Z",
  tradingDate: "2026-09-01",
  label: "",
  bucket: "csp",
  instrument: "option",
  quantity: 100,
  strike: null,
  expiryDate: null,
  stockPrice: null,
  stockPriceSource: null,
  commissionDollars: null,
  premiumDollars: 0,
  stockDollars: 0,
  unrealized: false,
  ...overrides,
});

describe("cycleCashBreakEven", () => {
  // A $40 put sold for 49.32 net and assigned; a call sold for 30.00 net; 100 more shares bought at 45.00 (0.50 commission).
  const timeline = [
    row({ label: "Sold put @ 0.50", strike: 40, premiumDollars: 49.32 }),
    row({ label: "Put assigned: shares bought at the strike", strike: 40, stockPrice: 40 }),
    row({ label: "Sold call @ 0.31", bucket: "cc", strike: 44, premiumDollars: 30 }),
    row({ label: "Bought shares", bucket: "unstructured", instrument: "stock", stockPrice: 45, commissionDollars: 0.5 }),
  ];

  it("divides what the shares held must bring back by them", () => {
    // (4,000 + 4,500.50 − 79.32) ÷ 200 shares marked at the end.
    const marked = [row({ at: null, label: "Marked to the 2026-09-30 close", bucket: "cc", instrument: "stock", quantity: 100 }), row({ at: null, label: "Marked to the 2026-09-30 close", bucket: "unstructured", instrument: "stock", quantity: 100 })];
    expect(cycleCashBreakEven([...timeline, ...marked])).toBeCloseTo(42.1059, 4);
  });

  it("counts what shares that left brought in, and leaves an open option's mark and a hedge out", () => {
    // 100 shares called away at 44.00 (0.60 commission): (8,500.50 − 4,399.40 − 79.32) ÷ 100.
    const after = [
      ...timeline,
      row({ label: "Call assigned: shares called away at the strike", bucket: "cc", strike: 44, stockPrice: 44, commissionDollars: 0.6 }),
      row({ label: "Bought put @ 0.20", bucket: "hedge", premiumDollars: -20 }),
      row({ at: null, label: "Open call marked to market", bucket: "cc", premiumDollars: -12 }),
      row({ at: null, label: "Marked to the 2026-09-30 close", bucket: "unstructured", instrument: "stock", quantity: 100 }),
    ];
    expect(cycleCashBreakEven(after)).toBeCloseTo(40.2178, 4);
  });

  it("has none without shares held", () => {
    expect(cycleCashBreakEven(timeline.slice(0, 1))).toBeNull();
  });

  it("gives each sale the break-even from before its moment, a look's sales one value", () => {
    // Shares held from the assignment; two calls sold in one look share the value from before it; a put sold later sees both premiums.
    const at = "2026-09-08T14:00:00.000Z";
    const rows = [
      timeline[0]!,
      { ...timeline[1]!, at: "2026-09-04T20:00:00.000Z" },
      row({ at, label: "Sold call @ 0.40", bucket: "cc", strike: 42, premiumDollars: 39.32 }),
      row({ at, label: "Sold call @ 0.20", bucket: "cc", strike: 43, premiumDollars: 19.32 }),
      row({ at: "2026-09-09T14:00:00.000Z", label: "Sold put @ 0.50", strike: 38, premiumDollars: 49.32 }),
    ];
    // Before the put sale: none held. Then (4,000 − 49.32) ÷ 100 = 39.5068, for both calls; the put: (4,000 − 49.32 − 58.64) ÷ 100.
    expect(cashBreakEvenBeforeEachRow(rows).map((value) => (value === null ? null : Number(value.toFixed(4))))).toEqual([null, null, 39.5068, 39.5068, 38.9204]);
  });

  it("counts shares across a split on one scale, each row's on its own day", () => {
    // 100 shares bought at $1,000 before a 10-for-1 split (factor 10, 1 after it from 15 Sep), a $110 call sold on 1,000 after it.
    const splitFactorOf = (tradingDate: string) => (tradingDate < "2026-09-15" ? 10 : 1);
    const rows = [
      row({ at: "2026-09-01T14:00:00.000Z", label: "Bought shares", bucket: "unstructured", instrument: "stock", stockPrice: 1000 }),
      row({ at: "2026-09-16T14:00:00.000Z", tradingDate: "2026-09-16", label: "Sold call @ 2.00", bucket: "cc", quantity: 1000, strike: 110, premiumDollars: 2000 }),
      row({ at: null, tradingDate: "2026-09-30", label: "Marked to the 2026-09-30 close", bucket: "cc", instrument: "stock", quantity: 1000 }),
    ];
    // Before the call: $100,000 over 1,000 shares as traded on the 16th = $100.00 (not $1,000 over 100).
    expect(cashBreakEvenBeforeEachRow(rows, splitFactorOf).map((value) => (value === null ? null : Number(value.toFixed(4))))).toEqual([null, 100, 98]);
    expect(sharesHeldAfterEachMoment(rows, splitFactorOf)).toEqual([100, 1000, 1000]);
    // At an instant, as traded on a day: 100 just after the purchase, 1,000 on the 16th; nothing before it.
    expect(sharesHeldAtInstant(rows, Date.parse("2026-09-01T14:00:00.000Z"), "2026-09-01", splitFactorOf)).toBe(100);
    expect(sharesHeldAtInstant(rows, Date.parse("2026-09-16T00:00:00.000Z"), "2026-09-16", splitFactorOf)).toBe(1000);
    expect(sharesHeldAtInstant(rows, Date.parse("2026-09-01T13:59:00.000Z"), "2026-09-01", splitFactorOf)).toBe(0);
    expect(cycleCashBreakEven(rows)).toBeCloseTo(98, 6);
  });
});

describe("sharesHeldAfterEachMoment", () => {
  it("gives every row of a look the shares once the look is done, and each change after it", () => {
    // A buy-write lists the call before the shares: both show 100. The put is assigned, then 100 called away.
    const at = "2026-09-01T14:00:00.000Z";
    const rows = [
      row({ at, label: "Sold call @ 0.40", bucket: "cc", strike: 42, premiumDollars: 39.32 }),
      row({ at, label: "Bought shares", bucket: "cc", instrument: "stock", stockPrice: 40 }),
      row({ at, label: "Sold put @ 0.50", strike: 38, premiumDollars: 49.32 }),
      row({ at: "2026-09-04T20:00:00.000Z", label: "Put assigned: shares bought at the strike", strike: 38, stockPrice: 38 }),
      row({ at: "2026-09-04T20:00:00.000Z", label: "Call assigned: shares called away at the strike", bucket: "cc", strike: 42, stockPrice: 42 }),
      row({ at: null, label: "Marked to the 2026-09-30 close", bucket: "unstructured", instrument: "stock", quantity: 100 }),
    ];
    expect(sharesHeldAfterEachMoment(rows)).toEqual([100, 100, 100, 100, 100, 100]);
    expect(sharesHeldAfterEachMoment(rows.slice(0, 4))).toEqual([100, 100, 100, 200]);
  });
});

describe("the hedge's realized P&L in the break-even", () => {
  // 600 shares bought at 687 (3.00 commission); 6 hedge Puts $690 bought for 49,984.08; a rung's 300 shares assigned at
  // 240; 3 Puts sold for 140,241.96 (they cost 24,992.04): realized 115,249.92. 900 shares held at the end.
  const purchase = row({ at: "2021-11-01T14:00:00.000Z", tradingDate: "2021-11-01", label: "Bought put @ 83.30", bucket: "hedge", strike: 690, expiryDate: "2022-09-16", quantity: 600, premiumDollars: -49_984.08 });
  const timeline = [
    row({ at: "2021-11-01T14:00:00.000Z", tradingDate: "2021-11-01", label: "Bought shares", bucket: "cc", instrument: "stock", quantity: 600, stockPrice: 687, commissionDollars: 3 }),
    purchase,
    row({ at: "2022-04-22T20:00:00.000Z", tradingDate: "2022-04-22", label: "Put assigned: shares bought at the strike", bucket: "csp", strike: 240, stockPrice: 240, quantity: 300 }),
    row({ at: "2022-04-25T14:00:00.000Z", tradingDate: "2022-04-25", label: "Sold put @ 467.48", bucket: "hedge", strike: 690, expiryDate: "2022-09-16", quantity: 300, premiumDollars: 140_241.96 }),
    row({ at: null, tradingDate: "2022-04-25", label: "Marked to the 2022-04-25 close", bucket: "unstructured", instrument: "stock", quantity: 900 }),
  ];
  const withoutHedge = (600 * 687 + 3 + 300 * 240) / 900;

  it("leaves the hedge out unless it is included", () => {
    expect(cycleCashBreakEven(timeline)).toBeCloseTo(withoutHedge, 6);
    expect(cycleCashBreakEven(timeline, undefined, { hedgeRealizedPnlIncluded: true })).toBeCloseTo(withoutHedge - 115_249.92 / 900, 6);
  });

  it("counts a sale's gain from its moment on, never a purchase", () => {
    const breakEvens = cashBreakEvenBeforeEachRow([...timeline.slice(0, 4), row({ at: "2022-05-02T14:00:00.000Z", tradingDate: "2022-05-02", label: "Sold call @ 1.00", bucket: "cc", strike: 450, premiumDollars: 0 })], undefined, { hedgeRealizedPnlIncluded: true });
    expect(breakEvens[2]).toBeCloseTo((600 * 687 + 3) / 600, 6);
    expect(breakEvens[4]).toBeCloseTo(withoutHedge - 115_249.92 / 900, 6);
  });

  it("gives a Call sold at the look of a hedge sale the floor with that sale's gain in it, as the engine sells the hedge first", () => {
    const callAtTheSameLook = row({ at: "2022-04-25T14:00:00.000Z", tradingDate: "2022-04-25", label: "Sold call @ 1.00", bucket: "cc", strike: 450, premiumDollars: 0 });
    const breakEvens = cashBreakEvenBeforeEachRow([...timeline.slice(0, 4), callAtTheSameLook], undefined, { hedgeRealizedPnlIncluded: true });
    expect(breakEvens[4]).toBeCloseTo(withoutHedge - 115_249.92 / 900, 6);
    expect(cashBreakEvenBeforeEachRow([...timeline.slice(0, 4), callAtTheSameLook])[4]).toBeCloseTo(withoutHedge, 6);
  });

  it("matches a sale after a split to its purchase before it by split-adjusted shares", () => {
    // NFLX's 10-for-1 split between the purchase (factor 10) and the sale (factor 1): 300 shares as traded at $690 are 3,000 at $69.
    const splitFactorOf = (tradingDate: string) => (tradingDate < "2022-04-23" ? 10 : 1);
    const afterSplit = timeline.map((entry) => (entry.label.startsWith("Sold put") ? { ...entry, strike: 69, quantity: 3000 } : entry.label.startsWith("Marked") ? { ...entry, quantity: 9000 } : entry));
    expect(cycleCashBreakEven(afterSplit, splitFactorOf, { hedgeRealizedPnlIncluded: true })! * 10).toBeCloseTo(withoutHedge - 115_249.92 / 900, 6);
  });
});
