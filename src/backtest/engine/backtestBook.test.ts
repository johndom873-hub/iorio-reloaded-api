import { describe, expect, it } from "vitest";
import {
  computeFreeCash,
  computeInterestDollars,
  computeParityStockPrice,
  computeSaleFillPrice,
  markAccountValue,
  openingCashChange,
  positionExposureDollars,
  positionMarkedExposureDollars,
  settlePosition,
  type BacktestBook,
  type BacktestPosition,
  type ParityQuote,
} from "./backtestBook.js";

const put: BacktestPosition = { tradeIndex: 0, strategyKey: "cash_secured_put", expiry: "2026-03-13", strike: 95, right: "P", contracts: 3, premium: 1.2, commissionDollars: 2.04, sharePriceAtOpen: null, openedAtMs: 0, lastMarkPerShare: 0.8, splitFactorAtOpen: 1 };
const coveredCall: BacktestPosition = { tradeIndex: 1, strategyKey: "covered_call", expiry: "2026-03-13", strike: 105, right: "C", contracts: 2, premium: 1.5, commissionDollars: 1.36, sharePriceAtOpen: 100, openedAtMs: 0, lastMarkPerShare: 2, splitFactorAtOpen: 1 };

describe("computeParityStockPrice", () => {
  // C − P = S − K·e^(−rT) at every strike, so each pair gives S back exactly.
  const stock = 100;
  const rate = 0.04;
  const years = 7 / 365;
  const pair = (expiry: string, strike: number, callMid: number, spread = 0.1): ParityQuote[] => {
    const putMid = callMid - stock + strike * Math.exp(-rate * years);
    return [
      { expiry, strike, right: "C", bid: callMid - spread / 2, ask: callMid + spread / 2 },
      { expiry, strike, right: "P", bid: putMid - spread / 2, ask: putMid + spread / 2 },
    ];
  };

  it("takes the median over the three strikes with the smallest call−put gap of the nearest expiry at least a day out", () => {
    const quotes = [...pair("2026-03-09", 100, 3), ...pair("2026-03-09", 95, 6), ...pair("2026-03-09", 105, 1), ...pair("2026-03-09", 80, 20.2), ...[{ expiry: "2026-03-02", strike: 100, right: "C" as const, bid: 50, ask: 51 }]];
    const result = computeParityStockPrice(quotes, "2026-03-02", rate, null)!;
    expect(result.expiry).toBe("2026-03-09");
    expect(result.strikes).toEqual([95, 100, 105]);
    expect(result.price).toBeCloseTo(stock, 8);
  });

  it("skips an expiry with fewer than three two-sided pairs when a later one has them", () => {
    const thinNearest: ParityQuote[] = [...pair("2026-03-06", 100, 2), { expiry: "2026-03-06", strike: 95, right: "C", bid: 0, ask: 5 }];
    const result = computeParityStockPrice([...thinNearest, ...pair("2026-03-09", 100, 3), ...pair("2026-03-09", 95, 6), ...pair("2026-03-09", 105, 1)], "2026-03-02", rate, null)!;
    expect(result.expiry).toBe("2026-03-09");
  });

  it("with a spread limit, ignores quotes wider than that share of their mid (the 10:00 price uses the fit's 50%)", () => {
    // The 100 strike is quoted 2.5 wide around a call mid of 3 (83% of the mid): without the limit it is one of the three.
    const quotes = [...pair("2026-03-09", 100, 3, 2.5), ...pair("2026-03-09", 95, 6), ...pair("2026-03-09", 105, 1), ...pair("2026-03-09", 110, 0.4, 0.1)];
    expect(computeParityStockPrice(quotes, "2026-03-02", rate, null)!.strikes).toEqual([95, 100, 105]);
    const limited = computeParityStockPrice(quotes, "2026-03-02", rate, 0.5)!;
    expect(limited.strikes).toEqual([95, 105, 110]);
    expect(limited.price).toBeCloseTo(stock, 8);
    expect(computeParityStockPrice(pair("2026-03-09", 100, 3, 2.5), "2026-03-02", rate, 0.5)).toBeNull();
  });

  it("is null without any two-sided call and put at one strike", () => {
    expect(computeParityStockPrice([{ expiry: "2026-03-09", strike: 100, right: "C", bid: 1, ask: 1.2 }], "2026-03-02", rate, null)).toBeNull();
  });
});

describe("fill, interest, exposure", () => {
  it("sells at the mid less the spread cost share of the half-spread", () => {
    // mid 1.10, half-spread 0.10, λ 0.5 → 1.05
    expect(computeSaleFillPrice(1.0, 1.2, 0.5)).toBeCloseTo(1.05, 12);
    expect(computeSaleFillPrice(1.0, 1.2, 0)).toBeCloseTo(1.1, 12);
  });

  it("credits interest on calendar days (FORMULAS.md example: $600,000 at 4.2% over a weekend = $207.12)", () => {
    expect(computeInterestDollars(600_000, 4.2, 3)).toBeCloseTo(207.12, 2);
  });

  it("measures EXP $ net of the premium, at the open and at the marks", () => {
    expect(positionExposureDollars(put)).toBeCloseTo((95 - 1.2) * 100 * 3, 8);
    expect(positionExposureDollars(coveredCall)).toBeCloseTo((100 - 1.5) * 100 * 2, 8);
    expect(positionMarkedExposureDollars(put, 97)).toBeCloseTo((95 - 0.8) * 300, 8);
    expect(positionMarkedExposureDollars(coveredCall, 103)).toBeCloseTo((103 - 2) * 200, 8);
  });

  it("marks cash less the short options plus the shares, and frees cash only beyond the puts' full strike", () => {
    const book: BacktestBook = { cash: 100_000, positions: [put, coveredCall] };
    expect(markAccountValue(book, 103)).toBeCloseTo(100_000 - 0.8 * 300 - 2 * 200 + 103 * 200, 8);
    expect(computeFreeCash(book)).toBeCloseTo(100_000 - 95 * 300, 8);
  });

  it("values a covered call opened before a 2-for-1 split on its opening scale: today's $48 is $96 a pre-split share", () => {
    const openedBeforeSplit: BacktestPosition = { ...coveredCall, splitFactorAtOpen: 2 };
    const book: BacktestBook = { cash: 0, positions: [openedBeforeSplit] };
    expect(markAccountValue(book, 48, 1)).toBeCloseTo(-2 * 200 + 96 * 200, 8);
    expect(positionMarkedExposureDollars(openedBeforeSplit, 48, 1)).toBeCloseTo((96 - 2) * 200, 8);
  });

  it("opens a put for its premium and a covered call net of the shares bought", () => {
    expect(openingCashChange(put)).toBeCloseTo(1.2 * 300 - 2.04, 8);
    expect(openingCashChange(coveredCall)).toBeCloseTo(1.5 * 200 - 1.36 - 100 * 200, 8);
  });
});

describe("settlePosition", () => {
  it("lets a put expire worthless above the strike: P&L = premium less commission", () => {
    const settlement = settlePosition(put, 96);
    expect(settlement).toEqual({ cashChange: -0, pnlDollars: 1.2 * 300 - 2.04, inTheMoneyAtExpiry: false });
  });

  it("pays a put's intrinsic value below the strike", () => {
    const settlement = settlePosition(put, 92.5);
    expect(settlement.cashChange).toBeCloseTo(-2.5 * 300, 8);
    expect(settlement.pnlDollars).toBeCloseTo(1.2 * 300 - 2.04 - 750, 8);
    expect(settlement.inTheMoneyAtExpiry).toBe(true);
  });

  it("sells a covered call's shares at the close below the strike", () => {
    const settlement = settlePosition(coveredCall, 98);
    expect(settlement.cashChange).toBeCloseTo(98 * 200, 8);
    expect(settlement.pnlDollars).toBeCloseTo(1.5 * 200 - 1.36 + (98 - 100) * 200, 8);
    expect(settlement.inTheMoneyAtExpiry).toBe(false);
  });

  it("delivers a covered call's shares at the strike above it", () => {
    const settlement = settlePosition(coveredCall, 110);
    expect(settlement.cashChange).toBeCloseTo(105 * 200, 8);
    expect(settlement.pnlDollars).toBeCloseTo(1.5 * 200 - 1.36 + (105 - 100) * 200, 8);
    expect(settlement.inTheMoneyAtExpiry).toBe(true);
  });
});
