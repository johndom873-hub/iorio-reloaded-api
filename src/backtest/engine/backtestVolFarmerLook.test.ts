import { describe, expect, it } from "vitest";
import { chooseVolFarmerPut, findVolFarmerCrossing, volFarmerHedgeSurplus, volFarmerOptionValue, volFarmerProtection, type VolFarmerPutCandidate } from "./backtestVolFarmerLook.js";

const commissionPerShare = 0.0068;

describe("volFarmerOptionValue", () => {
  it("prices a Put as Black-Scholes on the forward and floors it at intrinsic value", () => {
    // S 100, K 100, 45 days, IV 30%, r 4%: 3.95 (the figure the formula was approved on).
    expect(volFarmerOptionValue({ isCall: false, stockPrice: 100, strike: 100, yearsToExpiry: 45 / 365, riskFreeRate: 0.04, impliedVolatility: 0.3 })).toBeCloseTo(3.95, 2);
    expect(volFarmerOptionValue({ isCall: false, stockPrice: 80, strike: 100, yearsToExpiry: 0, riskFreeRate: 0.04, impliedVolatility: 0.3 })).toBe(20);
    // Deep in the money a European Put is worth less than its intrinsic value; a listed (American) one is not.
    expect(volFarmerOptionValue({ isCall: false, stockPrice: 50, strike: 100, yearsToExpiry: 1, riskFreeRate: 0.05, impliedVolatility: 0.1 })).toBe(50);
  });
});

describe("volFarmerHedgeSurplus", () => {
  it("passes an ATM Put when the stock reaches the Call's strike on its expiry day", () => {
    // S 100, $103 Call 7 days out, $100 Put 45 days out at IV 60%: the Put loses 1.90 of its 8.12 against the shares' +3.
    const put = { strike: 100, costPerShare: 8.12 + commissionPerShare, impliedVolatility: 0.6, yearsLeftAtCallExpiry: 38 / 365 };
    const surplus = volFarmerHedgeSurplus({ callStrike: 103, shareCostPerShare: 100, put, realizedHedgePnlPerShare: 0, riskFreeRate: 0.04 });
    expect(surplus).toBeCloseTo(3 - 1.9 - 2 * commissionPerShare, 1);
    expect(surplus).toBeGreaterThan(0);
  });

  it("fails when the Put's decay to the Call's expiry is more than the shares make", () => {
    // A $100.50 Call 14 days out: +0.50 from the shares, far less than a 14-day ATM Put at IV 60% loses to time.
    const put = { strike: 100, costPerShare: 3.25 + commissionPerShare, impliedVolatility: 0.6, yearsLeftAtCallExpiry: 0 };
    expect(volFarmerHedgeSurplus({ callStrike: 100.5, shareCostPerShare: 100, put, realizedHedgePnlPerShare: 0, riskFreeRate: 0.04 })).toBeLessThan(0);
  });

  it("counts the cycle's realized Put P&L and the shares' cost", () => {
    const put = { strike: 90, costPerShare: 1, impliedVolatility: 0.4, yearsLeftAtCallExpiry: 30 / 365 };
    const base = volFarmerHedgeSurplus({ callStrike: 95, shareCostPerShare: 100, put, realizedHedgePnlPerShare: 0, riskFreeRate: 0.04 });
    expect(volFarmerHedgeSurplus({ callStrike: 95, shareCostPerShare: 100, put, realizedHedgePnlPerShare: 6, riskFreeRate: 0.04 })).toBeCloseTo(base + 6, 10);
    expect(volFarmerHedgeSurplus({ callStrike: 95, shareCostPerShare: 98, put, realizedHedgePnlPerShare: 0, riskFreeRate: 0.04 })).toBeCloseTo(base + 2, 10);
  });
});

describe("volFarmerProtection", () => {
  it("is the share of a fall the Put offsets after its cost", () => {
    // 45-day ATM Put at IV 30% costs 3.95; a 20% fall within 7 days leaves it worth its intrinsic 20 (the European value is
    // just below): (20 − 3.95 − 0.0068) ÷ 20 = 80%.
    const put = { strike: 100, costPerShare: 3.95, impliedVolatility: 0.3, yearsLeftAtCallExpiry: 38 / 365 };
    expect(volFarmerProtection({ stockPrice: 100, fallFraction: 0.2, put, riskFreeRate: 0.04 })).toBeCloseTo(0.802, 3);
  });
});

describe("chooseVolFarmerPut", () => {
  const putQuote = (expiry: string, strike: number, fillPrice: number, impliedVolatility: number): VolFarmerPutCandidate => ({ expiry, strike, bid: fillPrice - 0.05, ask: fillPrice + 0.05, fillPrice, impliedVolatility });
  const look = { callStrike: 103, callExpiry: "2026-03-13", shareCostPerShare: 100, realizedHedgePnlPerShare: 0, stockPrice: 100, fallFraction: 0.2, riskFreeRate: 0.04 };

  it("takes the Put with the most protection among those that pass, never one expiring before the Call", () => {
    const puts = [putQuote("2026-03-06", 100, 1.2, 0.3), putQuote("2026-03-13", 100, 1.62, 0.3), putQuote("2026-04-17", 100, 3.95, 0.3), putQuote("2026-04-17", 95, 1.9, 0.3), putQuote("2027-03-05", 100, 9.78, 0.3)];
    const chosen = chooseVolFarmerPut({ ...look, puts })!;
    expect(chosen.put.expiry).toBe("2026-03-13");
    expect(chosen.put.strike).toBe(100);
    expect(chosen.surplus).toBeGreaterThanOrEqual(0);
    expect(chosen.protection).toBeGreaterThan(volFarmerProtection({ stockPrice: 100, fallFraction: 0.2, put: { strike: 100, costPerShare: 3.95 + commissionPerShare, impliedVolatility: 0.3, yearsLeftAtCallExpiry: 35 / 365 }, riskFreeRate: 0.04 }));
  });

  it("returns null when no Put passes the hedge rule", () => {
    // A Put priced far above its value: its loss at the strike is more than the shares' +3.
    expect(chooseVolFarmerPut({ ...look, puts: [putQuote("2026-03-13", 100, 9, 0.3)] })).toBeNull();
  });

  it("keeps to the Call's expiry with sameExpiry, where a longer Put would protect more", () => {
    const puts = [putQuote("2026-03-13", 95, 0.4, 0.3), putQuote("2026-04-17", 100, 3.95, 0.3)];
    expect(chooseVolFarmerPut({ ...look, puts })!.put.expiry).toBe("2026-04-17");
    expect(chooseVolFarmerPut({ ...look, puts, sameExpiry: true })!.put).toMatchObject({ expiry: "2026-03-13", strike: 95 });
  });

  it("refuses Puts below the least protection asked for", () => {
    // The March 95 Put offsets (95 − 80 − 0.41) ÷ 20 = 73% of a 20% fall; the April 100 Put about 80%.
    const puts = [putQuote("2026-03-13", 95, 0.4, 0.3), putQuote("2026-04-17", 100, 3.95, 0.3)];
    expect(chooseVolFarmerPut({ ...look, puts, sameExpiry: true, minProtection: 0.75 })).toBeNull();
    expect(chooseVolFarmerPut({ ...look, puts, minProtection: 0.75 })!.put.expiry).toBe("2026-04-17");
    expect(chooseVolFarmerPut({ ...look, puts, sameExpiry: true, minProtection: 0 })!.put.strike).toBe(95);
  });

  it("keeps within the Put budget, taking the most protection inside it", () => {
    // A Call sold at 1.00 with a 100% budget: the 3.95 April Put is out, the March 95 Put at 0.40 is in.
    const puts = [putQuote("2026-03-13", 95, 0.4, 0.3), putQuote("2026-03-13", 97, 1.2, 0.3), putQuote("2026-04-17", 100, 3.95, 0.3)];
    expect(chooseVolFarmerPut({ ...look, puts, maxFillPrice: 1 })!.put).toMatchObject({ expiry: "2026-03-13", strike: 95 });
    expect(chooseVolFarmerPut({ ...look, puts, maxFillPrice: 1.2 })!.put).toMatchObject({ expiry: "2026-03-13", strike: 97 });
    expect(chooseVolFarmerPut({ ...look, puts, maxFillPrice: 0.3 })).toBeNull();
  });
});

describe("findVolFarmerCrossing", () => {
  const bar = (startMinutesEt: number, open: number, high: number) => ({ startMinutesEt, open, high, close: open });

  it("crosses in the first bar whose high reaches the strike, at the strike, in the bar's middle", () => {
    const crossing = findVolFarmerCrossing([bar(600, 100, 101), bar(630, 101, 103.2), bar(660, 103, 104)], 103)!;
    expect(crossing.bar.startMinutesEt).toBe(630);
    expect(crossing.price).toBe(103);
    expect(crossing.minutesEt).toBe(645);
    expect(crossing.gapped).toBe(false);
  });

  it("fills at the open when the bar opened past the strike", () => {
    const crossing = findVolFarmerCrossing([bar(570, 106, 107)], 103)!;
    expect(crossing).toMatchObject({ price: 106, minutesEt: 570, gapped: true });
  });

  it("finds none below the strike", () => {
    expect(findVolFarmerCrossing([bar(570, 100, 102.99)], 103)).toBeNull();
  });
});
