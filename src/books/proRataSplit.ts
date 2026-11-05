import type { BookKey } from "./bookKeys.js";

// Splits an amount between the two books in proportion to their weights (Marcelo 2026-11-05: shared fees and unmatched
// statement rows by book value, interest by daily cash). Amounts keep 6 decimals, as the ledger stores them, and Manual
// takes what Pluto's rounded share leaves, so the two parts always add back up to the amount exactly.
// Example: a $4.50 fee with Pluto worth $600,000 and Manual $400,000 → Pluto −$2.70, Manual −$1.80.
// A weight below 0 counts as 0; with no positive weight the amount is split in halves.

export const ledgerDecimals = 6;

export function roundToLedgerDecimals(amount: number): number {
  const factor = 10 ** ledgerDecimals;
  return Math.round(amount * factor) / factor;
}

export function splitAmountByWeights(amount: number, weights: Record<BookKey, number>): Record<BookKey, number> {
  const plutoWeight = Math.max(0, weights.pluto);
  const manualWeight = Math.max(0, weights.manual);
  const totalWeight = plutoWeight + manualWeight;
  const plutoShare = totalWeight > 0 ? plutoWeight / totalWeight : 0.5;
  const pluto = roundToLedgerDecimals(amount * plutoShare);
  return { pluto, manual: roundToLedgerDecimals(amount - pluto) };
}
