import { describe, expect, it } from "vitest";
import type { MacroEventBeforeExpiry } from "../lib/macroEventTiming.js";
import { eventReviewKey, heldCoveredCallEntry, heldPutEntry, optionValueAfterEvent } from "./heldPositionMetrics.js";

// The approved worked examples (2026-10-08): spot $101, a normal day of 2% (forecast vol 0.02 × √252), a heavy release
// (k = 2, stressed spot $96.96) with 3 trading sessions to expiry after its session (3/252 of a year since 2026-10-09; 3/365 before).
const forecastVolatility = 0.02 * Math.sqrt(252);
const fed: MacroEventBeforeExpiry = { title: "Fed rate decision", weight: "heavy", dateIso: "2026-10-27", sessionIso: "2026-10-27", sessionsUntil: 3, sessionsAfter: 4 };
const leg = (strike: number, bid: number, ask: number) => ({ legId: "leg1", positionId: "pos1", strike, expiry: "2026-10-30", dte: 6, delta: -0.1, quantity: 1, bid, ask });
const stock = { shares: 100, spot: 101, stockBid: 100.99, stockAsk: 101.01 };

describe("held put (F2)", () => {
  const entry = heldPutEntry({ leg: leg(95, 0.12, 0.16), entryCredit: 1, spot: 101, forecastVolatility, event: fed, commissionPerContract: 0.68 });

  it("the worked example: 84% captured, $14 left, $2.68 to close, 3.0 normal days from the strike, ~$43 stress loss", () => {
    expect(entry.capturedPct).toBeCloseTo(84, 9);
    expect(entry.maxRemainingGainDollars).toBeCloseTo(14, 9);
    expect(entry.closeCostDollars).toBeCloseTo(0.02 * 100 + 0.68, 9);
    expect(entry.strikeDistanceDays).toBeCloseTo(2.97, 2);
    // The put at $96.96 with 3 sessions left at forecast vol is worth ~0.570: (0.570 − 0.14) × 100.
    expect(entry.eventStressLossDollars).toBeCloseTo(43.04, 2);
    expect(entry.event).toMatchObject({ title: "Fed rate decision", stressNormalDays: 2 });
  });

  it("scales with the event's weight and the quantity", () => {
    const light = heldPutEntry({ leg: leg(95, 0.12, 0.16), entryCredit: 1, spot: 101, forecastVolatility, event: { ...fed, title: "GDP", weight: "light" }, commissionPerContract: 0.68 });
    expect(light.event?.stressNormalDays).toBe(0.5);
    expect(light.eventStressLossDollars!).toBeLessThan(entry.eventStressLossDollars!);
    const three = heldPutEntry({ leg: { ...leg(95, 0.12, 0.16), quantity: 3 }, entryCredit: 1, spot: 101, forecastVolatility, event: fed, commissionPerContract: 0.68 });
    expect(three.eventStressLossDollars).toBeCloseTo(entry.eventStressLossDollars! * 3, 9);
    expect(three.closeCostDollars).toBeCloseTo(entry.closeCostDollars! * 3, 9);
  });

  it("no event, no forecast or no quote leaves the dependent figures empty", () => {
    expect(heldPutEntry({ leg: leg(95, 0.12, 0.16), entryCredit: 1, spot: 101, forecastVolatility, event: null, commissionPerContract: 0.68 })).toMatchObject({ event: null, eventStressLossDollars: null, capturedPct: 84 });
    expect(heldPutEntry({ leg: leg(95, 0.12, 0.16), entryCredit: 1, spot: 101, forecastVolatility: null, event: fed, commissionPerContract: 0.68 })).toMatchObject({ eventStressLossDollars: null, strikeDistanceDays: null });
    expect(heldPutEntry({ leg: { ...leg(95, 0.12, 0.16), bid: null }, entryCredit: 1, spot: 101, forecastVolatility, event: fed, commissionPerContract: 0.68 })).toMatchObject({ capturedPct: null, maxRemainingGainDollars: null, closeCostDollars: null, eventStressLossDollars: null });
  });
});

describe("held covered call", () => {
  it("example (a), call far above the stock: ~$414 up against ~$391 down, ordinary stock exposure", () => {
    const entry = heldCoveredCallEntry({ callLeg: leg(105, 0.12, 0.16), entryCredit: 1, ...stock, forecastVolatility, event: fed, commissionPerContract: 0.68, cycleTotal: 500 });
    expect(entry.maxRemainingGainDollars).toBeCloseTo(414, 6);
    expect(entry.eventStressLossDollars).toBeCloseTo(391.28, 2);
    // Close cost: call half-spread $2 + commission $0.68 + shares half-spread $1.
    expect(entry.closeCostDollars).toBeCloseTo(3.68, 9);
    expect(entry.cyclePnlAfterCostsDollars).toBeCloseTo(500 - 3.68, 9);
    expect(entry.strikeDistanceDays).toBeCloseTo(1.98, 2);
  });

  it("example (b), call in the money: ~$20 up against ~$116 down, the shape of a put", () => {
    const entry = heldCoveredCallEntry({ callLeg: leg(97, 4.18, 4.22), entryCredit: 5, ...stock, forecastVolatility, event: fed, commissionPerContract: 0.68 });
    expect(entry.maxRemainingGainDollars).toBeCloseTo(20, 6);
    expect(entry.eventStressLossDollars).toBeCloseTo(116.03, 2);
    expect(entry.strikeDistanceDays).toBeLessThan(0);
    // The gate was not read: no cycle P&L field at all.
    expect(entry).not.toHaveProperty("cyclePnlAfterCostsDollars");
  });

  it("a cycle P&L the gate could not read stays null", () => {
    expect(heldCoveredCallEntry({ callLeg: leg(105, 0.12, 0.16), entryCredit: 1, ...stock, forecastVolatility, event: fed, commissionPerContract: 0.68, cycleTotal: null }).cyclePnlAfterCostsDollars).toBeNull();
  });
});

describe("optionValueAfterEvent", () => {
  it("a release on expiry day leaves the intrinsic value", () => {
    expect(optionValueAfterEvent({ stressedSpot: 96, strike: 97, isCall: false, sessionsLeftAfterEvent: 0, forecastVolatility })).toBe(1);
    expect(optionValueAfterEvent({ stressedSpot: 96, strike: 97, isCall: true, sessionsLeftAfterEvent: 0, forecastVolatility })).toBe(0);
  });
});

describe("eventReviewKey (F4)", () => {
  it("moves on 10-point captured steps and on each session closer", () => {
    expect(eventReviewKey({ capturedPct: 84, event: { ...fed, stressNormalDays: 2 } })).toBe("c80s3");
    expect(eventReviewKey({ capturedPct: 89.9, event: { ...fed, stressNormalDays: 2 } })).toBe("c80s3");
    expect(eventReviewKey({ capturedPct: 90, event: { ...fed, stressNormalDays: 2 } })).toBe("c90s3");
    expect(eventReviewKey({ capturedPct: 84, event: { ...fed, sessionsUntil: 2, stressNormalDays: 2 } })).toBe("c80s2");
    expect(eventReviewKey({ capturedPct: null, event: null })).toBe("c?s?");
  });
});
