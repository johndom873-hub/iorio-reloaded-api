import { yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { calendarDaysPerYear } from "../sessionAnalytics.js";

// The simulated account of one backtest session (docs/backtesting/FORMULAS.md). Pure: cash, the open short options (each
// cash-secured put, or 100 shares per contract bought at the open with the call sold against them), the 10:00 marks,
// interest on cash, the fill price of a sale and the settlement at the expiry's close.
//
//   stock price at 10:00 = median of C − P + K·e^(−rT) over the three strikes nearest the money of the nearest expiry with
//                          at least one day left (T in calendar years); "nearest the money" = smallest |C − P| at the mid;
//                          only quotes whose spread is at most 50% of the mid (the fit's own rule, Marcelo 2026-10-12)
//   account value        = cash − Σ option 10:00 mid × 100 × contracts + Σ shares × 10:00 stock price
//   interest             = cash × rate × calendar days since the previous trading day ÷ 365
//   sale price           = mid − spread cost share × (ask − bid) ÷ 2, less the commission per contract
//   settlement           = put: pays max(0, K − close) × 100 per contract; covered call: the shares go at min(close, K)
//   EXP $                = (strike − premium) × 100 × contracts for a put; (share price − premium) × 100 × contracts for a call
// A position keeps the price scale of its opening day: its strike, premium and share price are as traded then. After a
// split (splitFactors.ts) today's traded stock price is put on that scale by × F(open) ÷ F(today).

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

export interface BacktestPosition {
  /** The trade this position belongs to (index into the session's trades). */
  tradeIndex: number;
  strategyKey: "cash_secured_put" | "covered_call";
  expiry: string;
  strike: number;
  right: "C" | "P";
  contracts: number;
  /** Sale price per share. */
  premium: number;
  commissionDollars: number;
  /** Covered call: price per share paid for the shares; null for a put. */
  sharePriceAtOpen: number | null;
  /** The 10:00 instant of the open (the ticker cooldown's clock). */
  openedAtMs: number;
  /** The option's last 10:00 mid on the opening scale, carried when a later day has no quote for it. */
  lastMarkPerShare: number;
  /** F on the opening day: the cumulative split factor the position's prices are quoted on. */
  splitFactorAtOpen: number;
}

export interface BacktestBook {
  cash: number;
  positions: BacktestPosition[];
}

/** EXP $ at the open, net of the premium (the live capitalAtRisk): constant for the position's life. */
export function positionExposureDollars(position: Pick<BacktestPosition, "strategyKey" | "strike" | "premium" | "sharePriceAtOpen" | "contracts">): number {
  const basis = position.strategyKey === "covered_call" ? position.sharePriceAtOpen! : position.strike;
  return (basis - position.premium) * sharesPerContract * position.contracts;
}

/** Today's traded stock price on the position's opening scale. */
export function stockPriceOnOpeningScale(position: Pick<BacktestPosition, "splitFactorAtOpen">, stockPrice: number, splitFactorToday: number): number {
  return (stockPrice * position.splitFactorAtOpen) / splitFactorToday;
}

/** The exposure at today's marks (the live positionExposure.ts value): the put's collateral or the shares, less the option at its mark. */
export function positionMarkedExposureDollars(position: BacktestPosition, stockPrice: number, splitFactorToday = 1): number {
  const held = position.strategyKey === "covered_call" ? stockPriceOnOpeningScale(position, stockPrice, splitFactorToday) : position.strike;
  return (held - position.lastMarkPerShare) * sharesPerContract * position.contracts;
}

/** cash − Σ option marks + Σ shares at the stock price (today's traded price, F(today) its split factor). */
export function markAccountValue(book: BacktestBook, stockPrice: number, splitFactorToday = 1): number {
  let value = book.cash;
  for (const position of book.positions) {
    value -= position.lastMarkPerShare * sharesPerContract * position.contracts;
    if (position.strategyKey === "covered_call") value += stockPriceOnOpeningScale(position, stockPrice, splitFactorToday) * sharesPerContract * position.contracts;
  }
  return value;
}

/** Cash not reserved for the open puts at their full strike (the live accountContextFromCash: IBKR cash already holds the premiums). */
export function computeCashLockedInPuts(book: BacktestBook): number {
  return book.positions.filter((position) => position.strategyKey === "cash_secured_put").reduce((sum, position) => sum + position.strike * sharesPerContract * position.contracts, 0);
}

export function computeFreeCash(book: BacktestBook): number {
  return Math.max(0, book.cash - computeCashLockedInPuts(book));
}

/** Updates each position's mark (on its opening scale); a position the day has no quote for keeps its last mark. */
export function updatePositionMarks(book: BacktestBook, markOf: (position: BacktestPosition) => number | null): void {
  for (const position of book.positions) {
    const mark = markOf(position);
    if (mark !== null) position.lastMarkPerShare = mark;
  }
}

export interface Settlement {
  /** Cash in (+) or out (−) at the close. */
  cashChange: number;
  /** The trade's realized P&L for all contracts, after its commission. */
  pnlDollars: number;
  inTheMoneyAtExpiry: boolean;
}

/** The position held to expiry and settled at the expiry day's close. */
export function settlePosition(position: Pick<BacktestPosition, "strategyKey" | "strike" | "contracts" | "premium" | "commissionDollars" | "sharePriceAtOpen">, closePrice: number): Settlement {
  const shares = sharesPerContract * position.contracts;
  const premiumReceived = position.premium * shares - position.commissionDollars;
  if (position.strategyKey === "cash_secured_put") {
    const cashChange = -Math.max(0, position.strike - closePrice) * shares;
    return { cashChange, pnlDollars: premiumReceived + cashChange, inTheMoneyAtExpiry: closePrice < position.strike };
  }
  const salePrice = Math.min(closePrice, position.strike);
  return { cashChange: salePrice * shares, pnlDollars: premiumReceived + (salePrice - position.sharePriceAtOpen!) * shares, inTheMoneyAtExpiry: closePrice > position.strike };
}

/** Cash effect of opening: the premium less commission; a covered call also pays for its shares. */
export function openingCashChange(position: Pick<BacktestPosition, "strategyKey" | "contracts" | "premium" | "commissionDollars" | "sharePriceAtOpen">): number {
  const shares = sharesPerContract * position.contracts;
  const premiumReceived = position.premium * shares - position.commissionDollars;
  return position.strategyKey === "covered_call" ? premiumReceived - position.sharePriceAtOpen! * shares : premiumReceived;
}
