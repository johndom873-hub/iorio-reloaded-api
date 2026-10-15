import { easternInstant } from "../../../../lib/easternIsoDate.js";
import { buyBackPut, closeCoveredCall, creditInterest, openCashSecuredPut, openCoveredCall, rollLeg, sellShares, settleExpiry } from "../ledgerEvents.js";
import { createSimulatedLedger, type SimulatedLedger } from "../simulatedLedger.js";

// A book three weeks into March 2026, six symbols, every event of the applier at least once. Shared by the selector
// tests and the database parity test; each symbol's cash is worked out beside it ($0.68 per contract, $0.005 per share).
// Every option here finishes out of the money or at least $0.05 in it, where the platform's inference from the expiry
// close (the tables have no column for how a leg settled) and the ledger's own rule give the same outcome.
//
// WHL  put assigned, a call expires, the next call takes the shares           closed cycle  +287.96
//   2 Mar  sell 1 put $50 6 Mar @ 1.20                 +120 − 0.68
//   6 Mar  close 48.00: assigned, 100 sh at 50         −5,000
//   9 Mar  sell 1 call $51 13 Mar @ 0.80 on the shares +80 − 0.68
//  13 Mar  close 50.50: worthless, shares kept
//  16 Mar  sell 1 call $50 20 Mar @ 0.90               +90 − 0.68
//  20 Mar  close 52.00: called away at 50              +5,000
// MIX  two lots, a call on one, a partial sale, a call on all with a top-up    open cycle    −5,771.60
//   2 Mar  sell 2 puts $30 6 Mar @ 0.50                +100 − 1.36
//   6 Mar  close 29.00: assigned, 200 sh at 30         −6,000
//   9 Mar  sell 1 call $31 13 Mar @ 0.45 on 100 of them +45 − 0.68          (the other 100 stay uncovered)
//  10 Mar  sell 40 uncovered sh @ 30.49 (stock 30.50)  +1,219.60 − 0.20
//  13 Mar  close 30.20: worthless; 160 sh uncovered
//  16 Mar  sell 2 calls $31 27 Mar @ 0.40, buying 40 sh @ 30.31 (stock 30.30)   −1,212.40 − 0.20 + 80 − 1.36
//          the covered call holds 200 sh at (160 × 30 + 40 × 30.31 + 0.20) ÷ 200 = 30.063
// ROL  a put rolled down and out                                               open cycle    +215.92
//   2 Mar  sell 2 puts $40 6 Mar @ 0.60                +120 − 1.36
//   5 Mar  buy them back @ 0.90, sell 2 puts $39 27 Mar @ 1.40   −180 − 1.36 + 280 − 1.36
// BWR  a Covered Call entry called away; a put bought back; a covered call closed whole three closed cycles +295.64, +23.64, +70.64
//   2 Mar  buy 200 sh @ 30.01 (stock 30.00), sell 2 calls $31 6 Mar @ 0.50   −6,002 − 1.00 + 100 − 1.36
//   6 Mar  close 31.50: called away at 31              +6,200
//   9 Mar  sell 1 put $30 13 Mar @ 0.35                +35 − 0.68
//  11 Mar  buy it back @ 0.10                          −10 − 0.68
//  16 Mar  buy 100 sh @ 31.01 (stock 31.00), sell 1 call $32 27 Mar @ 0.55   −3,101 − 0.50 + 55 − 0.68
//  18 Mar  buy the call back @ 0.30, sell the shares @ 31.49 (stock 31.50)   −30 − 0.68 + 3,149 − 0.50
// SLD  put assigned, shares sold at a profit                                   closed cycle  +137.82
//   2 Mar  sell 1 put $20 6 Mar @ 0.40                 +40 − 0.68
//   6 Mar  close 19.50: assigned, 100 sh at 20         −2,000
//  10 Mar  sell 100 sh @ 20.99 (stock 21.00)           +2,099 − 0.50
// FRE  put assigned, shares still uncovered                                    open cycle    −985.68
//   2 Mar  sell 1 put $10 13 Mar @ 0.15                +15 − 0.68
//  13 Mar  close 9.50: assigned, 100 sh at 10          −1,000
// Interest of 20.55 is credited on 3 March. Cash: 250,000 + 20.55 + 287.96 − 5,771.60 + 215.92 + 389.92 + 137.82 − 985.68 = 244,294.89.

export const fixtureStartingCash = 250_000;
export const fixtureInterestDollars = 20.55;
export const fixtureFinalCash = 244_294.89;
export const fixtureSymbols = ["WHL", "MIX", "ROL", "BWR", "SLD", "FRE"] as const;
export type FixtureSymbol = (typeof fixtureSymbols)[number];

/** Net cash each symbol moved (premium, commissions, shares, assignments). */
export const fixtureCashBySymbol: Record<FixtureSymbol, number> = { WHL: 287.96, MIX: -5771.6, ROL: 215.92, BWR: 389.92, SLD: 137.82, FRE: -985.68 };

export const fixtureSectorBySymbol = new Map<string, string | null>([["WHL", "Technology"], ["MIX", "Technology"], ["ROL", "Financial"], ["BWR", "Energy"], ["SLD", "Energy"], ["FRE", null]]);

/** Daily closes per symbol, ascending: the settlement closes above, the days shares changed bucket, and the 20 March mark. */
export const fixtureDailyCloses: Record<FixtureSymbol, { date: string; close: number }[]> = {
  WHL: [{ date: "2026-03-06", close: 48 }, { date: "2026-03-09", close: 49 }, { date: "2026-03-13", close: 50.5 }, { date: "2026-03-16", close: 50.8 }, { date: "2026-03-20", close: 52 }],
  MIX: [{ date: "2026-03-06", close: 29 }, { date: "2026-03-09", close: 29.8 }, { date: "2026-03-10", close: 30.5 }, { date: "2026-03-13", close: 30.2 }, { date: "2026-03-16", close: 30.3 }, { date: "2026-03-20", close: 30.6 }],
  ROL: [{ date: "2026-03-05", close: 39.5 }, { date: "2026-03-20", close: 39.2 }],
  BWR: [{ date: "2026-03-06", close: 31.5 }, { date: "2026-03-11", close: 30.9 }, { date: "2026-03-18", close: 31.5 }],
  SLD: [{ date: "2026-03-06", close: 19.5 }, { date: "2026-03-10", close: 21 }],
  FRE: [{ date: "2026-03-13", close: 9.5 }, { date: "2026-03-20", close: 9.8 }],
};

/** The 20 March marks of what is still held: MIX shares 30.60 and its calls 0.25, the ROL puts 1.00, the FRE shares 9.80. */
export const fixtureMarks = { mixStock: 30.6, mixCall: 0.25, rolPut: 1, freStock: 9.8 };

export interface FinishedLedgerFixture {
  ledger: SimulatedLedger;
  /** The positions and legs still open at the end. */
  open: { mixCoveredCallPositionId: string; mixCallLegId: string; mixStockLegId: string; rolPutPositionId: string; rolPutLegId: string; freSharesPositionId: string; freStockLegId: string };
  /** Mark per share of every open leg, by leg id. */
  priceByLegId: Map<string, number>;
  /** Mark per share of the open option legs only. */
  optionMarkByLegId: Map<string, number>;
}

/** 10:00 Eastern, the decision instant of a simulated day. */
export const decisionAt = (dateIso: string): Date => easternInstant(dateIso, 10, 0);

export function buildFinishedLedgerFixture(): FinishedLedgerFixture {
  const ledger = createSimulatedLedger(fixtureStartingCash, easternInstant("2026-03-02", 9, 30));
  let actionNumber = 0;
  const nextActionId = () => `action-${(actionNumber += 1)}`;
  const openPut = (symbol: string, dateIso: string, expiryDate: string, strike: number, contracts: number, fillPrice: number) => openCashSecuredPut(ledger, { symbol, expiryDate, strike, contracts, fillPrice, at: decisionAt(dateIso), actionId: nextActionId(), splitFactorToday: 1 });
  const openCall = (symbol: string, dateIso: string, expiryDate: string, strike: number, contracts: number, callFillPrice: number, stockPrice: number | null) =>
    openCoveredCall(ledger, { symbol, expiryDate, strike, contracts, callFillPrice, stockFillPrice: stockPrice === null ? null : stockPrice + 0.01, at: decisionAt(dateIso), actionId: nextActionId(), splitFactorToday: 1 });

  const whlPut = openPut("WHL", "2026-03-02", "2026-03-06", 50, 1, 1.2);
  const mixPut = openPut("MIX", "2026-03-02", "2026-03-06", 30, 2, 0.5);
  const rolPut = openPut("ROL", "2026-03-02", "2026-03-06", 40, 2, 0.6);
  const bwrFirstCall = openCall("BWR", "2026-03-02", "2026-03-06", 31, 2, 0.5, 30);
  const sldPut = openPut("SLD", "2026-03-02", "2026-03-06", 20, 1, 0.4);
  const frePut = openPut("FRE", "2026-03-02", "2026-03-13", 10, 1, 0.15);
  creditInterest(ledger, decisionAt("2026-03-03"), fixtureInterestDollars);

  const rolRolled = rollLeg(ledger, { legId: rolPut.legId, newExpiryDate: "2026-03-27", newStrike: 39, buybackFillPrice: 0.9, newFillPrice: 1.4, at: decisionAt("2026-03-05"), actionId: nextActionId() });

  settleExpiry(ledger, { legId: whlPut.legId, expiryClose: 48 });
  settleExpiry(ledger, { legId: mixPut.legId, expiryClose: 29 });
  settleExpiry(ledger, { legId: bwrFirstCall.callLegId, expiryClose: 31.5 });
  settleExpiry(ledger, { legId: sldPut.legId, expiryClose: 19.5 });

  const whlFirstCall = openCall("WHL", "2026-03-09", "2026-03-13", 51, 1, 0.8, null);
  const mixFirstCall = openCall("MIX", "2026-03-09", "2026-03-13", 31, 1, 0.45, null);
  const bwrPut = openPut("BWR", "2026-03-09", "2026-03-13", 30, 1, 0.35);

  sellShares(ledger, { positionId: mixFirstCall.leftoverPositionId!, shares: 40, fillPrice: 30.49, at: decisionAt("2026-03-10"), actionId: nextActionId() });
  const sldSharesPositionId = ledger.positions.find((position) => position.symbol === "SLD" && position.status === "open")!.id;
  sellShares(ledger, { positionId: sldSharesPositionId, shares: 100, fillPrice: 20.99, at: decisionAt("2026-03-10"), actionId: nextActionId() });

  buyBackPut(ledger, { legId: bwrPut.legId, fillPrice: 0.1, at: decisionAt("2026-03-11"), actionId: nextActionId() });

  settleExpiry(ledger, { legId: whlFirstCall.callLegId, expiryClose: 50.5 });
  settleExpiry(ledger, { legId: mixFirstCall.callLegId, expiryClose: 30.2 });
  settleExpiry(ledger, { legId: frePut.legId, expiryClose: 9.5 });

  const whlSecondCall = openCall("WHL", "2026-03-16", "2026-03-20", 50, 1, 0.9, null);
  const mixSecondCall = openCall("MIX", "2026-03-16", "2026-03-27", 31, 2, 0.4, 30.3);
  const bwrSecondCall = openCall("BWR", "2026-03-16", "2026-03-27", 32, 1, 0.55, 31);

  closeCoveredCall(ledger, { positionId: bwrSecondCall.positionId, callFillPrice: 0.3, stockFillPrice: 31.49, at: decisionAt("2026-03-18"), actionId: nextActionId() });

  settleExpiry(ledger, { legId: whlSecondCall.callLegId, expiryClose: 52 });

  const freSharesPosition = ledger.positions.find((position) => position.symbol === "FRE" && position.status === "open")!;
  const freStockLeg = ledger.legs.find((leg) => leg.positionId === freSharesPosition.id && leg.exitAt === null)!;
  const priceByLegId = new Map<string, number>([[mixSecondCall.stockLegId, fixtureMarks.mixStock], [mixSecondCall.callLegId, fixtureMarks.mixCall], [rolRolled.legId, fixtureMarks.rolPut], [freStockLeg.id, fixtureMarks.freStock]]);
  return {
    ledger,
    open: { mixCoveredCallPositionId: mixSecondCall.positionId, mixCallLegId: mixSecondCall.callLegId, mixStockLegId: mixSecondCall.stockLegId, rolPutPositionId: rolRolled.positionId, rolPutLegId: rolRolled.legId, freSharesPositionId: freSharesPosition.id, freStockLegId: freStockLeg.id },
    priceByLegId,
    optionMarkByLegId: new Map<string, number>([[mixSecondCall.callLegId, fixtureMarks.mixCall], [rolRolled.legId, fixtureMarks.rolPut]]),
  };
}
