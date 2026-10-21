import { describe, expect, it } from "vitest";
import { defaultBacktestBaselineSettings } from "../backtestTypes.js";
import { betaOnSpy, kellyMultiplier, knifeGuardScale, ladderBuyingSizing, ladderSizingMeasures, type DailyClose, type LadderSizingMeasures } from "./ladderSizing.js";

const settings = { ...defaultBacktestBaselineSettings, putsWhenNoCall: "reserve_ladder" as const };
const dynamic = { ...settings, kellySizing: "dynamic" as const };
const measures = (overrides: Partial<LadderSizingMeasures>): LadderSizingMeasures => ({ extensionZ: null, fallFromHigh: null, beta: null, spyFallFromHigh: null, marketShareOfFall: null, impliedVolatilityEased: null, spyMove21: null, ...overrides });

describe("the Kelly multiplier", () => {
  it("is 1 when disabled, and the constant with the constant rule", () => {
    expect(kellyMultiplier(settings, measures({ extensionZ: 1.9 })).multiplier).toBe(1);
    expect(kellyMultiplier({ ...dynamic, kellyMultiplierRule: "constant", kellyConstantMultiplier: 0.75 }, measures({ extensionZ: 1.9 })).multiplier).toBe(0.75);
  });

  it("cuts at tops: MRNA on 2021-09-20 (z 1.24) gets 0.26 with 0.5 → 1.5 and 0.76 with 1.0 → 2.0; SMCI on 2024-03-08 (z 1.88) 0 and 0.12", () => {
    expect(kellyMultiplier(dynamic, measures({ extensionZ: 1.24 })).multiplier).toBeCloseTo(0.26, 9);
    expect(kellyMultiplier({ ...dynamic, kellyTopFromZ: 1, kellyTopToZ: 2 }, measures({ extensionZ: 1.24 })).multiplier).toBeCloseTo(0.76, 9);
    expect(kellyMultiplier(dynamic, measures({ extensionZ: 1.88 })).multiplier).toBe(0);
    expect(kellyMultiplier({ ...dynamic, kellyTopFromZ: 1, kellyTopToZ: 2 }, measures({ extensionZ: 1.88 })).multiplier).toBeCloseTo(0.12, 9);
    expect(kellyMultiplier(dynamic, measures({ extensionZ: 1.24 })).topReading).toBe(true);
  });

  it("boosts at bottoms: SPY on 2020-03-23 (z −0.49) gets 1.49 with a most of 2, z −1.3 the most; 1 between 0 and the cut, and without z", () => {
    expect(kellyMultiplier(dynamic, measures({ extensionZ: -0.49 })).multiplier).toBeCloseTo(1.49, 9);
    expect(kellyMultiplier(dynamic, measures({ extensionZ: -1.3 })).multiplier).toBe(2);
    expect(kellyMultiplier({ ...dynamic, kellyMaxMultiplier: 1 }, measures({ extensionZ: -1.3 })).multiplier).toBe(1);
    expect(kellyMultiplier(dynamic, measures({ extensionZ: 0.3 })).multiplier).toBe(1);
    expect(kellyMultiplier(dynamic, measures({ extensionZ: null })).multiplier).toBe(1);
  });

  it("with SPY's month on: full up to +2%, 0.75 at +4%, half from +6%", () => {
    const spyOn = { ...dynamic, kellySpyMove: "on" as const };
    expect(kellyMultiplier(spyOn, measures({ extensionZ: 0.3, spyMove21: 0.01 })).multiplier).toBe(1);
    expect(kellyMultiplier(spyOn, measures({ extensionZ: 0.3, spyMove21: 0.04 })).multiplier).toBeCloseTo(0.75, 9);
    expect(kellyMultiplier(spyOn, measures({ extensionZ: 0.3, spyMove21: 0.09 })).multiplier).toBeCloseTo(0.5, 9);
  });
});

describe("the falling-knife guard", () => {
  const guard = { ...settings, knifeGuard: "market_share" as const };

  it("leaves new buying alone when off, less than 25% below the high, or without the market's share", () => {
    expect(knifeGuardScale(settings, measures({ fallFromHigh: 0.6, marketShareOfFall: 0 })).scale).toBe(1);
    expect(knifeGuardScale(guard, measures({ fallFromHigh: 0.2, marketShareOfFall: 0 })).scale).toBe(1);
    expect(knifeGuardScale(guard, measures({ fallFromHigh: 0.6, marketShareOfFall: null })).scale).toBe(1);
  });

  it("scales by the market's share of the fall: PTON on 2021-11-08 (q 0.00) stops; q 0.25 halves; from q 0.5 nothing changes", () => {
    expect(knifeGuardScale(guard, measures({ fallFromHigh: 0.67, marketShareOfFall: 0 })).scale).toBe(0);
    expect(knifeGuardScale(guard, measures({ fallFromHigh: 0.67, marketShareOfFall: 0.25 })).scale).toBeCloseTo(0.5, 9);
    expect(knifeGuardScale(guard, measures({ fallFromHigh: 0.32, marketShareOfFall: 1 })).scale).toBe(1);
    expect(knifeGuardScale({ ...guard, knifeGuardMinScale: 0.5 }, measures({ fallFromHigh: 0.67, marketShareOfFall: 0 })).scale).toBe(0.5);
  });

  it("halves it again while implied volatility is at its peak, with market_share_and_iv", () => {
    const withIv = { ...settings, knifeGuard: "market_share_and_iv" as const };
    expect(knifeGuardScale(withIv, measures({ fallFromHigh: 0.4, marketShareOfFall: 1, impliedVolatilityEased: false })).scale).toBe(0.5);
    expect(knifeGuardScale(withIv, measures({ fallFromHigh: 0.4, marketShareOfFall: 1, impliedVolatilityEased: true })).scale).toBe(1);
  });
});

describe("the look's sizing", () => {
  it("is none with the guard off and Kelly disabled (today's sizes)", () => {
    expect(ladderBuyingSizing(settings, measures({ extensionZ: 1.5, fallFromHigh: 0.5, marketShareOfFall: 0 }))).toBeNull();
  });

  it("multiplies the two within 0 and the most, pools with Kelly dynamic, and sends the held-back room to deeper Puts only at a top", () => {
    const both = { ...dynamic, knifeGuard: "market_share" as const };
    const atBottom = ladderBuyingSizing(both, measures({ extensionZ: -0.49, fallFromHigh: 0.67, marketShareOfFall: 0.25 }))!;
    expect(atBottom.buyingScale).toBeCloseTo(1.49 * 0.5, 9);
    expect(atBottom.pool).toBe(true);
    expect(atBottom.deeperPutsDepth).toBeNull();
    const guardOnly = ladderBuyingSizing({ ...settings, knifeGuard: "market_share" }, measures({ extensionZ: -0.49, fallFromHigh: 0.67, marketShareOfFall: 0.25 }))!;
    expect(guardOnly.buyingScale).toBeCloseTo(0.5, 9);
    expect(guardOnly.pool).toBe(false);
    const atTop = ladderBuyingSizing({ ...dynamic, kellyAtTops: "deeper_puts" }, measures({ extensionZ: 1.24 }))!;
    expect(atTop.buyingScale).toBeCloseTo(0.26, 9);
    // 0.30 × (1 − 0.26) = 0.222: at $100 the Puts' strikes at most $77.80.
    expect(atTop.deeperPutsDepth).toBeCloseTo(0.222, 9);
    expect(ladderBuyingSizing(dynamic, measures({ extensionZ: 1.24 }))!.deeperPutsDepth).toBeNull();
  });
});

describe("the measures", () => {
  const days = (count: number) => Array.from({ length: count }, (_, index) => new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10));

  it("finds the fall from the 252-session high, β on SPY and the market's share of the fall", () => {
    const dates = days(301);
    // SPY alternates ±1%; the stock moves twice as much (β 2), then falls 30% below its high in its last close.
    const spy: DailyClose[] = dates.map((date, index) => ({ date, close: 100 * (index % 2 === 0 ? 1 : 1.01) }));
    const stock: DailyClose[] = dates.map((date, index) => ({ date, close: 50 * (index % 2 === 0 ? 1 : 1.0201) }));
    expect(betaOnSpy(stock, new Map(spy.map((bar) => [bar.date, bar.close])))!).toBeCloseTo(2, 2);
    const fallen = [...stock.slice(0, -1), { date: stock.at(-1)!.date, close: 50 * 1.0201 * 0.7 }];
    const result = ladderSizingMeasures({ closesBeforeToday: fallen, impliedVolatilitiesBeforeToday: [0.5, 0.8, 0.75], spyClosesBeforeToday: spy, spyCloseByDate: new Map(spy.map((bar) => [bar.date, bar.close])) });
    expect(result.fallFromHigh).toBeCloseTo(0.3, 9);
    // SPY ends 1% below its high (its last close is a low day): q = β × 1% ÷ 30%, about 0.07.
    expect(result.spyFallFromHigh).toBeCloseTo(1 - 1 / 1.01, 9);
    expect(result.marketShareOfFall!).toBeGreaterThan(0.05);
    expect(result.marketShareOfFall!).toBeLessThan(0.1);
    // IV 0.75 against a 21-session high of 0.80: 6% below it, not 10%.
    expect(result.impliedVolatilityEased).toBe(false);
  });
});
