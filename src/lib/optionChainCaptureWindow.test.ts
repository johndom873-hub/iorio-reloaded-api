import { describe, expect, it } from "vitest";
import { calendarDaysUntilExpiry, computeStrikeWindow, selectContractsToCapture } from "./optionChainCaptureWindow.js";

describe("computeStrikeWindow", () => {
  it("is ±2 standard deviations of the move to expiry: 2 × IV × √(DTE/365)", () => {
    const window = computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0.3, daysToExpiry: 30 });
    const expected = 2 * 0.3 * Math.sqrt(30 / 365);
    expect(window!.halfWidth).toBeCloseTo(expected, 12);
    expect(window!.lowerBound).toBeCloseTo(100 * Math.exp(-expected), 9);
    expect(window!.upperBound).toBeCloseTo(100 * Math.exp(expected), 9);
  });

  it("floors 0DTE to one day for the width", () => {
    const zeroDte = computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0.5, daysToExpiry: 0 });
    const oneDte = computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0.5, daysToExpiry: 1 });
    expect(zeroDte!.halfWidth).toBeCloseTo(2 * 0.5 * Math.sqrt(1 / 365), 12);
    expect(zeroDte!.halfWidth).toBeCloseTo(oneDte!.halfWidth, 12);
  });

  it("clamps to a minimum of 5% for quiet, short-dated windows", () => {
    expect(computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0.15, daysToExpiry: 1 })!.halfWidth).toBe(0.05);
  });

  it("clamps to a maximum of 50% for long-dated, very high-IV windows", () => {
    // 2 × 1.51 × √(90/365) ≈ 1.5 unclamped
    expect(computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 1.51, daysToExpiry: 90 })!.halfWidth).toBe(0.5);
  });

  it("returns null for missing or non-physical inputs instead of inventing a fallback", () => {
    expect(computeStrikeWindow({ spotPrice: 0, atmImpliedVolatility: 0.3, daysToExpiry: 30 })).toBeNull();
    expect(computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0, daysToExpiry: 30 })).toBeNull();
    expect(computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: Number.NaN, daysToExpiry: 30 })).toBeNull();
    expect(computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0.3, daysToExpiry: -1 })).toBeNull();
  });
});

describe("selectContractsToCapture", () => {
  const strikes = Array.from({ length: 21 }, (_, i) => 90 + i); // 90..110

  it("captures OTM puts below spot and OTM calls above spot inside the window, plus the ATM pair", () => {
    const window = computeStrikeWindow({ spotPrice: 100.4, atmImpliedVolatility: 0.5, daysToExpiry: 0 })!; // ≈ ±5.2% → 95.3..105.8
    const contracts = selectContractsToCapture(strikes, 100.4, window);
    expect(contracts).toEqual([
      { strike: 96, right: "P" },
      { strike: 97, right: "P" },
      { strike: 98, right: "P" },
      { strike: 99, right: "P" },
      { strike: 100, right: "C" }, // the ATM pair: nearest strike to 100.4 is 100 — both rights
      { strike: 100, right: "P" },
      { strike: 101, right: "C" },
      { strike: 102, right: "C" },
      { strike: 103, right: "C" },
      { strike: 104, right: "C" },
      { strike: 105, right: "C" },
    ]);
  });

  it("does not capture in-the-money contracts (no calls below spot, no puts above spot) except the ATM pair", () => {
    const window = computeStrikeWindow({ spotPrice: 100.4, atmImpliedVolatility: 0.5, daysToExpiry: 0 })!;
    const contracts = selectContractsToCapture(strikes, 100.4, window);
    expect(contracts.filter((c) => c.right === "C" && c.strike < 100.4).map((c) => c.strike)).toEqual([100]);
    expect(contracts.filter((c) => c.right === "P" && c.strike > 100.4)).toEqual([]);
  });

  it("uses the lower strike when spot is exactly between two strikes", () => {
    const window = computeStrikeWindow({ spotPrice: 100.5, atmImpliedVolatility: 0.5, daysToExpiry: 0 })!;
    const contracts = selectContractsToCapture([100, 101], 100.5, window);
    expect(contracts).toEqual([
      { strike: 100, right: "C" },
      { strike: 100, right: "P" },
      { strike: 101, right: "C" },
    ]);
  });

  it("handles spot landing exactly on a strike: that strike is only the ATM pair, neighbours are OTM only", () => {
    const window = computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0.5, daysToExpiry: 0 })!;
    const contracts = selectContractsToCapture([99, 100, 101], 100, window);
    expect(contracts).toEqual([
      { strike: 99, right: "P" },
      { strike: 100, right: "C" },
      { strike: 100, right: "P" },
      { strike: 101, right: "C" },
    ]);
  });

  it("never returns duplicates", () => {
    const window = computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0.8, daysToExpiry: 30 })!;
    const contracts = selectContractsToCapture([...strikes, ...strikes], 100, window);
    const keys = contracts.map((c) => `${c.strike}|${c.right}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("still includes the ATM pair when the strike grid is so coarse the nearest strike is outside the window", () => {
    const window = computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0.15, daysToExpiry: 1 })!; // ±5%
    expect(selectContractsToCapture([80, 120], 100, window)).toEqual([
      { strike: 80, right: "C" },
      { strike: 80, right: "P" },
    ]);
  });

  it("returns nothing for an empty strike list", () => {
    const window = computeStrikeWindow({ spotPrice: 100, atmImpliedVolatility: 0.3, daysToExpiry: 30 })!;
    expect(selectContractsToCapture([], 100, window)).toEqual([]);
  });
});

describe("calendarDaysUntilExpiry", () => {
  it("is 0 for today, counts across a DST change, and is negative for the past", () => {
    expect(calendarDaysUntilExpiry("2026-09-21", "20260921")).toBe(0);
    expect(calendarDaysUntilExpiry("2026-09-21", "20260925")).toBe(4);
    expect(calendarDaysUntilExpiry("2026-10-30", "20261106")).toBe(7);
    expect(calendarDaysUntilExpiry("2026-09-21", "20261220")).toBe(90);
    expect(calendarDaysUntilExpiry("2026-09-21", "20260918")).toBe(-3);
  });
});
