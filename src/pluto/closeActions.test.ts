import { describe, expect, it } from "vitest";
import type { HeldLegScore, RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import { evaluateShortLegBuyback, evaluateUnstructuredClose, type UnstructuredSharePosition } from "./closeActions.js";
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
  const roll = (grade: RollSignalCandidate["grade"]): RollSignalCandidate => ({ legId: "leg9", positionId: "pos9", strategyKey: "cash_secured_put", quantity: 2, replacement: {} as never, netRollEdge: 0.01, netRollEdgeDollarsPerContract: 5, netRollEdgeDollars: 10, netCreditPerShare: 0.1, deltaChange: -0.01, dollarRiskChange: 0, flags: [], grade });
  const base = { symbol: "HOOD", leg, rolls: [], settings, singleLegPosition: true };

  it("offers the buyback at the mid when holding has negative net value and the ask locks a profit", () => {
    const { offer, reason } = evaluateShortLegBuyback(base);
    expect(reason).toBeNull();
    expect(offer).toMatchObject({ id: "HOOD:close_leg:leg9", kind: "close_leg", side: "buy", multiplier: 100, quantity: 2, limitPrice: 0.53, automatic: false });
    expect(offer!.cycle_pnl).toBeCloseTo((2.4 - 0.55) * 200, 6);
  });
  it("is withheld when holding still has value, a roll grades Weak or better, DTE is too short, or the ask would realise a loss", () => {
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, holdEdgeDollars: 20 } }).reason).toMatch(/holding still offers/);
    expect(evaluateShortLegBuyback({ ...base, rolls: [roll("weak")] }).reason).toMatch(/credit roll/);
    expect(evaluateShortLegBuyback({ ...base, rolls: [roll("avoid")] }).offer).not.toBeNull();
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, dte: 1 } }).reason).toMatch(/DTE 1 below 2/);
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, ask: 2.6, bid: 2.5 } }).reason).toMatch(/would realise/);
  });
  it("is limited to single-leg positions and needs a scored leg with a live quote", () => {
    expect(evaluateShortLegBuyback({ ...base, singleLegPosition: false }).reason).toMatch(/single-leg/);
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, unscoredReason: "no_quote" } }).reason).toMatch(/not scored/);
    expect(evaluateShortLegBuyback({ ...base, leg: { ...leg, ask: null } }).reason).toMatch(/two-sided quote/);
  });
});
