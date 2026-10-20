import { describe, expect, it } from "vitest";
import type { BacktestCycleTimelineRow } from "./backtestTypes.js";
import { cycleCashBreakEven } from "./cycleCashBreakEven.js";

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
});
