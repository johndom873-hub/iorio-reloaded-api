import { yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { calendarDaysPerYear } from "../sessionAnalytics.js";

// Pricing rules of a backtest session that need no book (docs/backtesting/FORMULAS.md). Pure. The book itself is the
// simulated ledger (ledger/).
//
//   stock price at 10:00 = median of C − P + K·e^(−rT) over the three strikes nearest the money of the nearest expiry with
//                          at least one day left (T in calendar years); "nearest the money" = smallest |C − P| at the mid;
//                          only quotes whose spread is at most 50% of the mid (the fit's own rule, Marcelo 2026-10-12)
//   interest             = cash × rate × calendar days since the previous trading day ÷ 365
//   sale price           = mid − spread cost share × (ask − bid) ÷ 2

export const sharesPerContract = 100;
/** How many strikes nearest the money the parity stock price is the median of. */
export const parityStrikeCount = 3;

export interface ParityQuote {
  expiry: string;
  strike: number;
  right: "C" | "P";
  bid: number | null;
  ask: number | null;
}

export interface ParityStockPrice {
  price: number;
  expiry: string;
  strikes: number[];
}

function midOf(quote: ParityQuote | undefined, maxSpreadFractionOfMid: number | null): number | null {
  if (!quote || quote.bid === null || quote.ask === null || !(quote.bid > 0) || !(quote.ask >= quote.bid)) return null;
  const mid = (quote.bid + quote.ask) / 2;
  if (maxSpreadFractionOfMid !== null && (quote.ask - quote.bid) / mid > maxSpreadFractionOfMid) return null;
  return mid;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The stock price the option quotes imply. The nearest expiry at least one calendar day out with three strikes quoted on
 * both sides (two-sided: bid > 0, ask ≥ bid) is used; when no expiry has three, the nearest with any. Null without a pair.
 * `maxSpreadFractionOfMid` drops wider quotes (the 10:00 price passes the fit's limit; split detection on closing quotes
 * passes null, its rolling median and ratio snapping absorb the noise).
 */
export function computeParityStockPrice(quotes: readonly ParityQuote[], todayIso: string, riskFreeRate: number, maxSpreadFractionOfMid: number | null): ParityStockPrice | null {
  const pairsByExpiry = new Map<string, Map<number, { call?: number; put?: number }>>();
  for (const quote of quotes) {
    if (quote.expiry <= todayIso) continue;
    const mid = midOf(quote, maxSpreadFractionOfMid);
    if (mid === null) continue;
    const byStrike = pairsByExpiry.get(quote.expiry) ?? new Map<number, { call?: number; put?: number }>();
    const pair = byStrike.get(quote.strike) ?? {};
    if (quote.right === "C") pair.call = mid;
    else pair.put = mid;
    byStrike.set(quote.strike, pair);
    pairsByExpiry.set(quote.expiry, byStrike);
  }
  const usable = [...pairsByExpiry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([expiry, byStrike]) => ({ expiry, pairs: [...byStrike.entries()].flatMap(([strike, pair]) => (pair.call !== undefined && pair.put !== undefined ? [{ strike, call: pair.call, put: pair.put }] : [])) }))
    .filter((entry) => entry.pairs.length > 0);
  const chosen = usable.find((entry) => entry.pairs.length >= parityStrikeCount) ?? usable[0];
  if (!chosen) return null;
  const years = yearsBetweenIsoDates(todayIso, chosen.expiry);
  const nearest = [...chosen.pairs].sort((a, b) => Math.abs(a.call - a.put) - Math.abs(b.call - b.put) || a.strike - b.strike).slice(0, parityStrikeCount);
  const price = median(nearest.map((pair) => pair.call - pair.put + pair.strike * Math.exp(-riskFreeRate * years)));
  return price > 0 ? { price, expiry: chosen.expiry, strikes: nearest.map((pair) => pair.strike).sort((a, b) => a - b) } : null;
}

/** Sale price per share: mid − spread cost share × half-spread. */
export function computeSaleFillPrice(bid: number, ask: number, spreadShareCharged: number): number {
  return (bid + ask) / 2 - (spreadShareCharged * (ask - bid)) / 2;
}

/** Interest on a cash balance over calendar days at a rate in percent. */
export function computeInterestDollars(cash: number, ratePercent: number, calendarDays: number): number {
  return (cash * (ratePercent / 100) * calendarDays) / calendarDaysPerYear;
}
