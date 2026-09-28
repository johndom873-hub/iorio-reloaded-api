import { deriveCycles, type CycleInput } from "./cycles.js";
import type { MarketSessionState } from "./marketSessionStatus.js";

// What the Close form shows and gates on, derived from live quotes (approved 2026-09-28). Pure so it can be
// tested without IBKR or a database; the SSE route (routes/positionCloseLive.ts) only feeds it quotes.
//
// "Live" is established by rules rather than read off a price, because a pooled price carries no timestamp
// and a stock's `last` can be the daily-close fallback the pool paints before the first tick. A quote counts
// as live only when the regular session is open and it has a real bid AND ask (the fallback only ever fills
// `last`). Closing is blocked otherwise, and whenever the ticker's wheel cycle is flagged as inconsistent.
//
// Live cycle P&L = the ordinary cycle derivation with two marks overridden: the shares are marked at the
// live stock last, and the position being closed has its open-option premium P&L set to
// (live mid - entry) x quantity x multiplier x (-1 short / +1 long), the same per-leg formula the
// Positions live P&L stream uses, with the bid/ask mid as the option price. Other open positions on the
// ticker keep their nightly snapshot marks.

export interface CloseLiveLeg {
  id: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  multiplier: number;
  entryPrice: number;
  /** Human label for block messages, e.g. "$152.5C 2026-09-25". */
  label: string;
}

export interface CloseLiveQuote {
  bid: number | null;
  ask: number | null;
  last: number | null;
}

export interface CloseLiveLegQuote extends CloseLiveQuote {
  mid: number | null;
}

export interface CloseLiveState {
  live: boolean;
  /** True while quotes are still being waited for (inside the settle grace) -- blocked, but not yet a failure. */
  pending: boolean;
  blockReason: string | null;
  marketOpen: boolean;
  legQuotes: Record<string, CloseLiveLegQuote>;
  /** Live wheel-cycle P&L; null whenever it cannot be trusted (blocked). */
  cycleTotal: number | null;
}

export interface DeriveCloseLiveStateInput {
  symbol: string;
  positionId: string;
  /** The position's open legs. */
  legs: CloseLiveLeg[];
  marketState: MarketSessionState;
  optionQuotesByLegId: Record<string, CloseLiveQuote | null | undefined>;
  /** The ticker's stock quote (also the stock leg's quote when the position has one). */
  stockQuote: CloseLiveQuote | null;
  cycleInput: CycleInput;
  todayIso: string;
  waitedMs: number;
  settleGraceMs: number;
}

function midOf(quote: CloseLiveQuote): number | null {
  if (quote.bid === null || quote.ask === null || quote.ask < quote.bid) return null;
  return (quote.bid + quote.ask) / 2;
}

/** A real two-sided market. Stocks also need `last` (it marks the shares) and a positive bid; an option's bid may be 0. */
function isUsableQuote(quote: CloseLiveQuote | null | undefined, isStock: boolean): boolean {
  if (!quote || quote.bid === null || quote.ask === null || quote.ask <= 0 || quote.ask < quote.bid) return false;
  if (isStock) return quote.bid > 0 && quote.last !== null && quote.last > 0;
  return quote.bid >= 0;
}

function describeMarketState(state: MarketSessionState): string {
  if (state === "pre-market") return "in pre-market";
  if (state === "after-hours") return "in after-hours trading";
  return "closed";
}

export function deriveCloseLiveState(input: DeriveCloseLiveStateInput): CloseLiveState {
  const { symbol, positionId, legs, marketState, optionQuotesByLegId, stockQuote, cycleInput, todayIso, waitedMs, settleGraceMs } = input;
  const marketOpen = marketState === "open";

  const legQuotes: Record<string, CloseLiveLegQuote> = {};
  for (const leg of legs) {
    const quote = leg.legType === "stock" ? stockQuote : (optionQuotesByLegId[leg.id] ?? null);
    if (quote) legQuotes[leg.id] = { ...quote, mid: midOf(quote) };
  }
  const blocked = (blockReason: string, pending = false): CloseLiveState => ({ live: false, pending, blockReason, marketOpen, legQuotes, cycleTotal: null });

  if (!marketOpen) {
    return blocked(`Closing is only available during regular trading hours (9:30 AM – 4:00 PM ET). The market is ${describeMarketState(marketState)} right now.`);
  }

  const optionLegs = legs.filter((leg) => leg.legType === "option");
  // The shares mark the cycle, so the stock quote is needed whenever the position or the ticker's cycle holds shares.
  const stockNeeded = legs.some((leg) => leg.legType === "stock") || cycleInput.stockLegs.some((leg) => leg.exitAt === null);
  const missingLabels = [
    ...optionLegs.filter((leg) => !isUsableQuote(optionQuotesByLegId[leg.id], false)).map((leg) => leg.label),
    ...(stockNeeded && !isUsableQuote(stockQuote, true) ? [`${symbol} stock`] : []),
  ];
  if (missingLabels.length > 0) {
    if (waitedMs < settleGraceMs) return blocked("Waiting for live quotes…", true);
    return blocked(`Live bid/ask is unavailable for ${missingLabels.join(", ")}. Closing needs live prices.`);
  }

  try {
    const optionPremiumPnl = optionLegs.reduce(
      (sum, leg) => sum + (legQuotes[leg.id]!.mid! - leg.entryPrice) * leg.quantity * leg.multiplier * (leg.side === "short" ? -1 : 1),
      0,
    );
    const openPositionPremiumPnl = new Map(cycleInput.openPositionPremiumPnl);
    if (optionLegs.length > 0) openPositionPremiumPnl.set(positionId, optionPremiumPnl);
    const cycles = deriveCycles({
      ...cycleInput,
      lastPrice: stockNeeded ? { date: todayIso, price: stockQuote!.last! } : cycleInput.lastPrice,
      openPositionPremiumPnl,
    });
    const openCycle = cycles.find((cycle) => cycle.status === "open");
    if (!openCycle) return blocked(`No open wheel cycle was found for ${symbol}, so closing can't be verified. Closing is blocked.`);
    if (openCycle.dataFlags.length > 0) {
      return blocked(`The ${symbol} wheel cycle has inconsistent data (${openCycle.dataFlags.join("; ")}). Closing is blocked until it is fixed.`);
    }
    return { live: true, pending: false, blockReason: null, marketOpen, legQuotes, cycleTotal: openCycle.total };
  } catch (error) {
    return blocked(`The ${symbol} wheel cycle P&L could not be computed (${error instanceof Error ? error.message : String(error)}). Closing is blocked.`);
  }
}
