import type { BookKey } from "../books/bookKeys.js";
import { assignmentFillsOf, isSettledWithoutTrade, marginalThreshold, settledAssigned, type CycleInput } from "./cycles.js";

// The P&L Analyser's trade statistics over closed short options (formulas approved by Marcelo 2026-11-13). A leg's result
// follows the fair attribution (cycles.ts), so an assigned put is charged for its assignment:
//   result          = credit − buyback (net of commissions); an assigned put also (expiry close − strike) × shares, less the
//                     assignment fill's commission; a called-away call is its premium only (its shares count in the CC bucket)
//   win rate        = legs with result > 0 ÷ all;  profit factor = Σ results > 0 ÷ |Σ results < 0|
//   premium capture = Σ (credit − buyback) ÷ Σ credit, at the fill prices (before commissions)
//   assignment rate = assigned puts ÷ puts held to expiry;  called-away rate = assigned calls ÷ calls held to expiry
//   days held       = mean calendar days from the sale to the close
// Each is shown from 10 closed legs. Example: a $50 put sold for $2.00, assigned with the stock at $46 → +$200 − $400 = −$200, a loss.
// A leg whose settlement cannot be read (no expiry bar, or within $0.05 of the strike) is left out, as its cycle is.

export const minimumClosedLegsForTradeStats = 10;

export interface ClosedShortOptionResult {
  legId: string;
  bucket: "csp" | "cc";
  closedAt: Date;
  result: number;
  grossCredit: number;
  grossBuyback: number;
  assigned: boolean;
  heldToExpiry: boolean;
  daysHeld: number;
}

/** Pure: every closed short option leg of one ticker's ledger with its result. */
export function closedShortOptionResults(input: CycleInput): ClosedShortOptionResult[] {
  const { fillByLegId } = assignmentFillsOf(input);
  const results: ClosedShortOptionResult[] = [];
  for (const leg of input.optionLegs) {
    if (leg.side !== "short" || leg.exitAt === null) continue;
    const shares = leg.quantity * leg.multiplier;
    const heldToExpiry = isSettledWithoutTrade(leg);
    let assigned = false;
    if (heldToExpiry && leg.settledAs !== "worthless") {
      if (leg.expiryClose === null) continue;
      const inTheMoneyBy = leg.optionType === "call" ? leg.expiryClose - leg.strike : leg.strike - leg.expiryClose;
      if (leg.settledAs === undefined && inTheMoneyBy > 0 && inTheMoneyBy < marginalThreshold) continue;
      assigned = settledAssigned(leg);
    }
    const buyback = leg.hasClosingTrade && leg.exitPrice !== null ? leg.exitPrice * shares + leg.closingCommission : 0;
    let result = leg.entryPrice * shares - buyback;
    if (assigned && leg.optionType === "put") {
      const fill = fillByLegId.get(leg.id);
      const pricePerShare = fill === undefined ? leg.strike : fill.price + fill.commission / shares;
      result += shares * (leg.expiryClose! - pricePerShare);
    }
    results.push({
      legId: leg.id,
      bucket: leg.optionType === "put" ? "csp" : "cc",
      closedAt: leg.exitAt,
      result,
      grossCredit: (leg.openingFillPrice ?? leg.entryPrice) * shares,
      grossBuyback: leg.hasClosingTrade && leg.exitPrice !== null ? (leg.closingFillPrice ?? leg.exitPrice) * shares : 0,
      assigned,
      heldToExpiry,
      daysHeld: (leg.exitAt.getTime() - leg.entryAt.getTime()) / 86_400_000,
    });
  }
  return results;
}

export interface GatedTradeFigure {
  value: number | null;
  have: number;
  need: number;
}

export interface TradeStats {
  closedCount: number;
  winRatePercent: GatedTradeFigure;
  profitFactor: GatedTradeFigure;
  premiumCapturePercent: GatedTradeFigure;
  /** Puts only: assigned ÷ held to expiry. */
  assignmentRatePercent: GatedTradeFigure | null;
  /** Calls only: called away ÷ held to expiry. */
  calledAwayRatePercent: GatedTradeFigure | null;
  averageDaysHeld: GatedTradeFigure;
}

/** Pure: the statistics of a set of closed legs; `kind` decides which of the two rates applies. */
export function summarizeTradeStats(legs: readonly Pick<ClosedShortOptionResult, "result" | "grossCredit" | "grossBuyback" | "assigned" | "heldToExpiry" | "daysHeld">[], kind: "csp" | "cc" | "both"): TradeStats {
  const count = legs.length;
  const gate = (value: number | null): GatedTradeFigure => ({ value: count >= minimumClosedLegsForTradeStats ? value : null, have: count, need: minimumClosedLegsForTradeStats });
  const wins = legs.filter((leg) => leg.result > 0);
  const lossTotal = legs.filter((leg) => leg.result < 0).reduce((sum, leg) => sum + leg.result, 0);
  const winTotal = wins.reduce((sum, leg) => sum + leg.result, 0);
  const credit = legs.reduce((sum, leg) => sum + leg.grossCredit, 0);
  const heldToExpiry = legs.filter((leg) => leg.heldToExpiry);
  const expiryRate = () => gate(heldToExpiry.length === 0 ? null : (heldToExpiry.filter((leg) => leg.assigned).length / heldToExpiry.length) * 100);
  return {
    closedCount: count,
    winRatePercent: gate(count === 0 ? null : (wins.length / count) * 100),
    profitFactor: gate(lossTotal === 0 ? null : winTotal / Math.abs(lossTotal)),
    premiumCapturePercent: gate(credit === 0 ? null : (legs.reduce((sum, leg) => sum + leg.grossCredit - leg.grossBuyback, 0) / credit) * 100),
    assignmentRatePercent: kind === "csp" ? expiryRate() : null,
    calledAwayRatePercent: kind === "cc" ? expiryRate() : null,
    averageDaysHeld: gate(count === 0 ? null : legs.reduce((sum, leg) => sum + leg.daysHeld, 0) / count),
  };
}

/** A stored result with the night and book it counts in. */
export interface StoredClosedShortOption extends Omit<ClosedShortOptionResult, "closedAt"> {
  tickerId: string;
  closedNight: string;
  bookKey: BookKey;
}
