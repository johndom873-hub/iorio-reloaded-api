import { describe, expect, it } from "vitest";
import type { HeldLegScore, RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import { countSessionsLeftBeforeEarnings, evaluateEarningsBuyback, evaluateEventCoveredCallClose, evaluateEventPutClose, evaluateShortLegBuyback, evaluateUnstructuredClose, eventCloseWindowSessions, mergeEventAndHoldEdgeBuybacks, orderedEntryPremium, type UnstructuredSharePosition } from "./closeActions.js";
import { heldCoveredCallEntry, heldPutEntry } from "./heldPositionMetrics.js";
import type { MacroEventBeforeExpiry } from "../lib/macroEventTiming.js";
import type { PlutoSettings } from "./settingsStore.js";

const settings = { unstructuredCloseMinPct: 1, unstructuredCloseMinDollars: 50, buybackMinDte: 2 } as PlutoSettings;

describe("Formula P1 — unstructured share close", () => {
  const position: UnstructuredSharePosition = { positionId: "pos1", symbol: "AAOI", legId: "leg1", shares: 300, entryPrice: 30, entryAtIso: "2026-09-20T15:00:00Z" };
  const base = { position, cycleTotal: 400, cycleBlockReason: null, stockBid: 31.1, stockAsk: 31.14, settings, previousSessionDateIso: "2026-09-25" };

  it("offers a full lot at the mid when the cycle P&L clears the floor", () => {
    const { offer, reason } = evaluateUnstructuredClose(base);
    expect(reason).toBeNull();
    expect(offer).toMatchObject({ id: "AAOI:close_shares:pos1", kind: "close_shares", automatic: false, limitPrice: 31.12, side: "sell", multiplier: 1, quantity: 300, legIds: ["leg1"] });
    expect(offer!.detail.cycle_pnl_pct_of_capital).toBeCloseTo(4.4, 1);
  });
  it("the floor is the larger of the percent and the dollar minimum", () => {
    // 1% of 9,000 = 90 > 50 → floor 90
    expect(evaluateUnstructuredClose({ ...base, cycleTotal: 80 }).reason).toMatch(/below the floor 90/);
    expect(evaluateUnstructuredClose({ ...base, cycleTotal: 90 }).offer).not.toBeNull();
    const tiny = { ...position, shares: 20, entryPrice: 30 }; // 1% of 600 = 6 < 50 → floor 50
    expect(evaluateUnstructuredClose({ ...base, position: tiny, cycleTotal: 40 }).reason).toMatch(/below the floor 50/);
  });
  it("never at a cycle loss, never on a flagged cycle, never on a fresh position", () => {
    expect(evaluateUnstructuredClose({ ...base, cycleTotal: -10 }).offer).toBeNull();
    expect(evaluateUnstructuredClose({ ...base, cycleBlockReason: "The AAOI wheel cycle has inconsistent data" }).reason).toMatch(/inconsistent/);
    expect(evaluateUnstructuredClose({ ...base, position: { ...position, entryAtIso: "2026-09-25T14:00:00Z" } }).reason).toMatch(/younger than one full session/);
    expect(evaluateUnstructuredClose({ ...base, position: { ...position, entryAtIso: "2026-09-24T14:00:00Z" } }).offer).not.toBeNull();
  });
  it("odd lots are automatic", () => {
    const odd = evaluateUnstructuredClose({ ...base, position: { ...position, shares: 50, entryPrice: 30 }, cycleTotal: 60 });
    expect(odd.offer?.automatic).toBe(true);
  });
  it("needs a live two-sided stock quote", () => {
    expect(evaluateUnstructuredClose({ ...base, stockBid: null }).reason).toMatch(/stock quote/);
  });
});

describe("Formula P2 — short-leg buyback", () => {
  const leg: HeldLegScore = {
    legId: "leg9", positionId: "pos9", strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 100, right: "P", quantity: 2, entryPrice: 2.4, entryAtIso: "2026-09-10T14:00:00Z",
    dte: 18, delta: -0.1, bid: 0.5, ask: 0.55, mid: 0.525, surfaceImpliedVolatility: 0.4, midImpliedVolatility: 0.42, edge: -0.05, frictionVolatility: 0.01, vega: 0.05, holdEdgeDollars: -25, closeCostDollars: 5, dollarRisk: 9948, quoteSource: "day", quotedAt: "2026-09-28T15:00:00Z", flags: [], unscoredReason: null,
  };
  const roll = (grade: RollSignalCandidate["grade"]): RollSignalCandidate => ({ legId: "leg9", positionId: "pos9", strategyKey: "cash_secured_put", quantity: 2, replacement: {} as never, netRollEdge: 0.01, netRollEdgeDollarsPerContract: 5, netRollEdgeDollars: 10, netCreditPerShare: 0.1, deltaChange: -0.01, dollarRiskChange: 0, flags: [], warnings: [], grade });
  const base = { symbol: "HOOD", leg, rolls: [], settings, singleLegPosition: true };

  it("offers the buyback at the mid when holding has negative net value and the ask locks a profit", () => {
    const { offer, reason } = evaluateShortLegBuyback(base);
    expect(reason).toBeNull();
    expect(offer).toMatchObject({ id: "HOOD:close_leg:leg9", kind: "close_leg", side: "buy", multiplier: 100, quantity: 2, limitPrice: 0.53, automatic: false });
    expect(offer!.cycle_pnl).toBeCloseTo((2.4 - 0.55) * 200, 6);
  });
  it("is withheld when holding still has value, a roll grades Weak or better, DTE is too short, or the ask would realise a loss", () => {
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, holdEdgeDollars: 20 } }).reason).toBe("holding is still worth $15 per contract more than buying back, after closing costs");
    expect(evaluateShortLegBuyback({ ...base, rolls: [roll("weak")] }).reason).toMatch(/credit roll/);
    expect(evaluateShortLegBuyback({ ...base, rolls: [roll("avoid")] }).offer).not.toBeNull();
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, dte: 1 } }).reason).toMatch(/DTE 1 below 2/);
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, ask: 2.6, bid: 2.5 } }).reason).toMatch(/^buying back at the ask would lose \$\d+$/);
    // Recorded 2.40, but we set 2.00 on the leg in a combo: an ask of 2.20 is a loss on what we really received.
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, ask: 2.2, bid: 2.1 } }).offer).not.toBeNull();
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, ask: 2.2, bid: 2.1 }, orderedEntryPremium: 2.0 }).reason).toBe("buying back at the ask would lose $40");
  });
  it("is limited to single-leg positions and needs a scored leg with a live quote", () => {
    expect(evaluateShortLegBuyback({ ...base, singleLegPosition: false }).reason).toMatch(/single-leg/);
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, unscoredReason: "no_quote" } }).reason).toMatch(/not scored/);
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, ask: null } }).reason).toMatch(/two-sided quote/);
  });
});

describe("orderedEntryPremium", () => {
  it("moves the recorded entry by IBKR's combo split, keeping its commission treatment", () => {
    // AMAT roll: we set the new call at 4.60, IBKR reported it at 5.04; recorded entry 5.0284 (commission in).
    expect(orderedEntryPremium(5.0284, [{ quantity: 1, price: 5.04, orderedLegPrice: 4.6 }])).toBeCloseTo(4.5884, 6);
    // SPCX buy-write: two fills at 1.61 and 1.59 against our 1.72.
    expect(orderedEntryPremium(1.5926, [{ quantity: 1, price: 1.61, orderedLegPrice: 1.72 }, { quantity: 1, price: 1.59, orderedLegPrice: 1.72 }])).toBeCloseTo(1.7126, 6);
  });
  it("is null for legs opened by single-leg orders and weights mixed openings by quantity", () => {
    expect(orderedEntryPremium(2.0, [{ quantity: 2, price: 2.01, orderedLegPrice: null }])).toBeNull();
    expect(orderedEntryPremium(2.0, [])).toBeNull();
    expect(orderedEntryPremium(2.0, [{ quantity: 1, price: 2.1, orderedLegPrice: 1.9 }, { quantity: 3, price: 2.0, orderedLegPrice: null }])).toBeCloseTo(1.95, 6);
  });
});

describe("Formula P3 — earnings buyback", () => {
  const leg: HeldLegScore = {
    legId: "leg9", positionId: "pos9", strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 100, right: "P", quantity: 2, entryPrice: 2.4, entryAtIso: "2026-09-10T14:00:00Z",
    dte: 18, delta: -0.1, bid: 0.5, ask: 0.55, mid: 0.525, surfaceImpliedVolatility: 0.4, midImpliedVolatility: 0.42, edge: -0.05, frictionVolatility: 0.01, vega: 0.05, holdEdgeDollars: -25, closeCostDollars: 5, dollarRisk: 9948, quoteSource: "day", quotedAt: "2026-09-28T15:00:00Z", flags: [], unscoredReason: null,
  };
  // HOOD reports 2026-10-27 after the close; the put expires 2026-10-30.
  const earnings = { dateIso: "2026-10-27", time: "1" };
  const base = { symbol: "HOOD", leg: { ...leg, expiry: "2026-10-30" }, singleLegPosition: true, earnings, sessionsLeft: 3 };

  it("buys back automatically at the mid inside the last 5 sessions when the ask locks a profit", () => {
    const { offer, reason } = evaluateEarningsBuyback(base);
    expect(reason).toBeNull();
    expect(offer).toMatchObject({ id: "HOOD:close_leg:leg9", kind: "close_leg", automatic: true, side: "buy", quantity: 2, limitPrice: 0.53 });
    expect(offer!.automaticReason).toContain("Formula P3");
  });
  it("never at a loss, never before the window, only on single-leg positions, only with a live quote", () => {
    expect(evaluateEarningsBuyback({ ...base, leg: { ...base.leg, bid: 2.5, ask: 2.6 } }).reason).toMatch(/would lose \$\d+, so it stays open$/);
    expect(evaluateEarningsBuyback({ ...base, sessionsLeft: 6 }).offer).toBeNull();
    expect(evaluateEarningsBuyback({ ...base, sessionsLeft: null }).reason).toMatch(/last 5 sessions/);
    expect(evaluateEarningsBuyback({ ...base, singleLegPosition: false }).reason).toMatch(/single-leg/);
    expect(evaluateEarningsBuyback({ ...base, leg: { ...base.leg, ask: null } }).reason).toMatch(/two-sided quote/);
  });
  it("does nothing for a leg that expires before the announcement, or with no announcement", () => {
    expect(evaluateEarningsBuyback({ ...base, leg: { ...base.leg, expiry: "2026-10-23" } })).toEqual({ offer: null, reason: null });
    expect(evaluateEarningsBuyback({ ...base, earnings: null })).toEqual({ offer: null, reason: null });
  });
});

describe("countSessionsLeftBeforeEarnings", () => {
  // Oct 2026: 19–23 and 26–30 are open sessions.
  const openDays = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"];
  it("counts the report day for an after-close report", () => {
    expect(countSessionsLeftBeforeEarnings("2026-10-21", { dateIso: "2026-10-27", time: "1" }, openDays.filter((day) => day >= "2026-10-21"))).toBe(5); // 21, 22, 23, 26, 27
    expect(countSessionsLeftBeforeEarnings("2026-10-20", { dateIso: "2026-10-27", time: "1" }, openDays.filter((day) => day >= "2026-10-20"))).toBe(6);
  });
  it("stops at the session before a before-open or unknown-time report", () => {
    expect(countSessionsLeftBeforeEarnings("2026-10-21", { dateIso: "2026-10-27", time: "-1" }, openDays.filter((day) => day >= "2026-10-21"))).toBe(4); // 21, 22, 23, 26
    expect(countSessionsLeftBeforeEarnings("2026-10-21", { dateIso: "2026-10-27", time: null }, openDays.filter((day) => day >= "2026-10-21"))).toBe(4);
  });
  it("is 1 on the last day, and while an unknown-time report today is still ahead", () => {
    expect(countSessionsLeftBeforeEarnings("2026-10-27", { dateIso: "2026-10-27", time: "1" }, ["2026-10-27"])).toBe(1);
    expect(countSessionsLeftBeforeEarnings("2026-10-27", { dateIso: "2026-10-27", time: "0" }, ["2026-10-27"])).toBe(1);
  });
});

describe("Formula F3 — event closes", () => {
  const forecastVolatility = 0.02 * Math.sqrt(252);
  const fed = (sessionsUntil: number): MacroEventBeforeExpiry => ({ title: "Fed rate decision", weight: "heavy", dateIso: "2026-10-27", sessionIso: "2026-10-27", sessionsUntil, sessionsAfter: 4 });
  const put: HeldLegScore = {
    legId: "leg7", positionId: "pos7", strategyKey: "cash_secured_put", expiry: "2026-10-30", strike: 95, right: "P", quantity: 1, entryPrice: 1, entryAtIso: "2026-10-09T14:00:00Z",
    dte: 6, delta: -0.08, bid: 0.12, ask: 0.16, mid: 0.14, surfaceImpliedVolatility: 0.45, midImpliedVolatility: 0.45, edge: 0.1, frictionVolatility: 0.01, vega: 0.03, holdEdgeDollars: 30, closeCostDollars: 3, dollarRisk: 9486, quoteSource: "day", quotedAt: "2026-10-24T15:00:00Z", flags: [], unscoredReason: null,
  };
  const putEntry = (sessionsUntil: number, overrides: Partial<HeldLegScore> = {}, entryCredit = 1) => heldPutEntry({ leg: { ...put, ...overrides }, entryCredit, spot: 101, forecastVolatility, event: fed(sessionsUntil), commissionPerContract: 0.68 });
  const putInput = (sessionsUntil: number, overrides: Partial<HeldLegScore> = {}, entryCredit = 1) => ({ symbol: "HOOD", leg: { ...put, ...overrides }, entry: putEntry(sessionsUntil, overrides, entryCredit), singleLegPosition: true, gateBlockReason: null });

  it("offers a put's buyback to the model inside the window even though holding edge is positive (P2 would not)", () => {
    const { offer, reason } = evaluateEventPutClose(putInput(3));
    expect(reason).toBeNull();
    expect(offer).toMatchObject({ id: "HOOD:close_leg:leg7", kind: "close_leg", automatic: false, side: "buy", multiplier: 100, quantity: 1, limitPrice: 0.14, reviewKey: "c80s3" });
    expect(offer!.description).toMatch(/before the 27 Oct Fed rate decision \(heavy, 3 sessions away\); locks 84 at the ask$/);
    expect(offer!.detail).toMatchObject({ event: "Fed rate decision", sessions_until: 3, captured_pct: 84, max_remaining_gain_dollars: 14, event_stress_loss_dollars: 25, close_cost_dollars: 3 });
    expect(evaluateShortLegBuyback({ symbol: "HOOD", leg: put, rolls: [], settings, singleLegPosition: true }).offer).toBeNull();
  });

  it("the window: exactly eventCloseWindowSessions sessions away is in, one more is out (null/null)", () => {
    expect(eventCloseWindowSessions).toBe(5);
    expect(evaluateEventPutClose(putInput(5)).offer).not.toBeNull();
    expect(evaluateEventPutClose(putInput(6))).toEqual({ offer: null, reason: null });
    expect(evaluateEventPutClose({ ...putInput(3), entry: { ...putEntry(3), event: null } })).toEqual({ offer: null, reason: null });
  });

  it("never at break-even or a loss, never on a blocked gate, a multi-leg position or a one-sided quote", () => {
    expect(evaluateEventPutClose(putInput(3, {}, 0.16)).reason).toMatch(/only break even, so it is held through it$/);
    expect(evaluateEventPutClose(putInput(3, {}, 0.1)).reason).toMatch(/would lose \$6, so it is held through it$/);
    expect(evaluateEventPutClose({ ...putInput(3), gateBlockReason: "Closing is blocked: the cycle has inconsistent data" }).reason).toMatch(/inconsistent data/);
    expect(evaluateEventPutClose({ ...putInput(3), singleLegPosition: false }).reason).toMatch(/single-leg positions/);
    expect(evaluateEventPutClose(putInput(3, { bid: null })).reason).toMatch(/two-sided quote/);
  });

  it("one offer per leg when P2 also applies: the event close, saying holding no longer pays", () => {
    const eventOffer = evaluateEventPutClose(putInput(3)).offer!;
    const p2 = evaluateShortLegBuyback({ symbol: "HOOD", leg: { ...put, holdEdgeDollars: -10 }, rolls: [], settings, singleLegPosition: true }).offer!;
    const merged = mergeEventAndHoldEdgeBuybacks(eventOffer, p2);
    expect(merged.id).toBe(p2.id);
    expect(merged.reviewKey).toBe("c80s3");
    expect(merged.description).toMatch(/holding also no longer pays its closing cost$/);
    expect(merged.detail).toMatchObject({ hold_edge_dollars: -10, also_hold_edge_negative: true, sessions_until: 3 });
    expect(mergeEventAndHoldEdgeBuybacks(eventOffer, null)).toBe(eventOffer);
  });

  describe("covered call (whole position)", () => {
    const call: HeldLegScore = { ...put, legId: "call1", positionId: "cc1", strategyKey: "covered_call", strike: 97, right: "C", bid: 4.18, ask: 4.22, mid: 4.2, entryPrice: 5 };
    const ccInput = (cycleTotal: number | null, sessionsUntil = 3) => {
      const entry = heldCoveredCallEntry({ callLeg: call, shares: 100, entryCredit: 5, spot: 101, stockBid: 100.99, stockAsk: 101.01, forecastVolatility, event: fed(sessionsUntil), commissionPerContract: 0.68, cycleTotal });
      return { symbol: "HOOD", positionId: "cc1", callLeg: call, stockLeg: { legId: "stock1", shares: 100 }, entry, stockBid: 100.99, stockAsk: 101.01, gateBlockReason: null };
    };

    it("offers the combo close to the model, each leg at its own mid, referenced on the shares", () => {
      const { offer } = evaluateEventCoveredCallClose(ccInput(250));
      expect(offer).toMatchObject({
        id: "HOOD:close_position:cc1", kind: "close_position", automatic: false, side: "sell", multiplier: 1, quantity: 100, limitPrice: 101,
        legIds: ["call1", "stock1"], legLimitPrices: { call1: 4.2, stock1: 101 }, otherReferenceLegs: [{ side: "buy", price: 4.2, multiplier: 100 }],
      });
      expect(offer!.cycle_pnl).toBeCloseTo(250 - 3.68, 9);
      expect(offer!.detail).toMatchObject({ max_remaining_gain_dollars: 20, event_stress_loss_dollars: 93, cycle_pnl_after_costs_dollars: 246 });
    });

    it("never when the cycle closed now is not in profit after the close cost, or unread", () => {
      expect(evaluateEventCoveredCallClose(ccInput(3)).reason).toMatch(/would lose \$1 after the close cost, so it is held through it$/);
      expect(evaluateEventCoveredCallClose(ccInput(null)).reason).toMatch(/no live cycle P&L/);
      expect(evaluateEventCoveredCallClose(ccInput(250, 6))).toEqual({ offer: null, reason: null });
      expect(evaluateEventCoveredCallClose({ ...ccInput(250), stockBid: null }).reason).toMatch(/two-sided quote/);
    });
  });
});
