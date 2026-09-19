// Approved 2026-09-19 (cycle design, see PROGRESS.md). A "cycle" is derived at
// read time, never stored: it opens with the first option sold / stock bought
// on a symbol and closes when the symbol is flat (no shares, no open option
// legs). This file computes the break-even the Positions column shows.
//
// Why a cash ledger and not position_legs.entry_price for the stock: a stock
// leg's entry_price is IBKR's average cost — commission-inclusive, premium-
// adjusted after an assigned put, and drifting over time (see memory
// project_leg_entry_price_is_ibkr_avgcost_not_fill) — so it is not a usable
// cost basis. The real cash flows are, and they are all recoverable:
//   stock buys / sells   -> the fills in `trades` (price x qty, plus commission)
//   put assigned         -> shares in at the strike (a short put that expired
//                           in the money per the expiry-date daily close; no fill exists)
//   call assigned        -> shares out at the strike (same test)
//   option premium       -> legs: credit received (entry_price is already net of the opening
//                           commission) minus buy-back paid minus closing-trade commissions;
//                           an open short counts at its credit ("if it expires worthless")
//
//   break-even per share = (cost of every share acquired in the cycle - net premium) / shares acquired
// i.e. average acquisition cost minus premium per share acquired — the pro-rata formula, CONFIRMED
// by Marcelo 2026-09-19 (he chose it over a whole-cycle cash version): after a partial sale the
// premium and cost stay spread over all shares ever acquired, so the sold shares' share of the
// premium leaves with them. Put-only cycle (no shares): the open short put's strike - net premium
// / put shares.
//
// Refuses to answer (null + reason) instead of guessing when the ledger cannot be trusted:
// an expired leg with no expiry-date bar, an expiry within $0.05 of the strike, or a
// ledger share count that disagrees with the open stock legs.

export interface CycleOptionLeg {
  id: string;
  positionId: string;
  side: "long" | "short";
  optionType: "call" | "put";
  strike: number;
  quantity: number;
  multiplier: number;
  entryPrice: number;
  entryAt: Date;
  exitPrice: number | null;
  exitAt: Date | null;
  /** Sum of trades.commission on this leg's closing trades (NULL counts as 0). */
  closingCommission: number;
  hasClosingTrade: boolean;
  expiryDate: string;
  /** Daily close on expiryDate, null when no bar exists. */
  expiryClose: number | null;
}

export interface CycleStockTrade {
  at: Date;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  commission: number;
}

export interface OpenCycleSummary {
  sharesHeld: number;
  sharesAcquired: number;
  /** Cost of every share acquired in the cycle (fills + commission, assigned puts at the strike). */
  acquisitionCost: number;
  netPremium: number;
  /** Per share held; null when it cannot be computed (see unavailableReason). */
  breakEvenPerShare: number | null;
  unavailableReason: string | null;
  /** Open short puts in the cycle, for the put-only (no shares yet) break-even of each position. */
  openShortPuts: { positionId: string; strike: number; shares: number }[];
}

const groupingWindowMs = 120_000;
const marginalThreshold = 0.05;

interface LedgerEvent {
  at: number;
  sharesDelta: number;
  openOptionsDelta: number;
  acquiredShares: number;
  acquiredCost: number;
}

function isSettledWithoutTrade(leg: CycleOptionLeg): boolean {
  return leg.side === "short" && leg.exitAt !== null && !leg.hasClosingTrade && (leg.exitPrice === 0 || leg.exitPrice === null);
}

/** Summary of the symbol's currently open cycle, or null when the symbol is flat. */
export function summarizeOpenCycle(
  optionLegs: CycleOptionLeg[],
  stockTrades: CycleStockTrade[],
  openStockShares: number,
): OpenCycleSummary | null {
  let unavailableReason: string | null = null;
  const events: LedgerEvent[] = [];

  for (const trade of stockTrades) {
    const signedShares = trade.side === "buy" ? trade.quantity : -trade.quantity;
    const isBuy = trade.side === "buy";
    events.push({ at: trade.at.getTime(), sharesDelta: signedShares, openOptionsDelta: 0, acquiredShares: isBuy ? trade.quantity : 0, acquiredCost: isBuy ? trade.quantity * trade.price + trade.commission : 0 });
  }

  for (const leg of optionLegs) {
    events.push({ at: leg.entryAt.getTime(), sharesDelta: 0, openOptionsDelta: 1, acquiredShares: 0, acquiredCost: 0 });
    if (leg.exitAt === null) continue;
    let sharesDelta = 0;
    let acquiredShares = 0;
    let acquiredCost = 0;
    if (isSettledWithoutTrade(leg)) {
      if (leg.expiryClose === null) {
        unavailableReason ??= `no expiry-date price bar for ${leg.optionType} $${leg.strike} (${leg.expiryDate})`;
      } else {
        const inTheMoneyBy = leg.optionType === "call" ? leg.expiryClose - leg.strike : leg.strike - leg.expiryClose;
        if (inTheMoneyBy > 0 && inTheMoneyBy < marginalThreshold) {
          unavailableReason ??= `${leg.optionType} $${leg.strike} (${leg.expiryDate}) expired within $${marginalThreshold} of the strike — assignment unclear`;
        } else if (inTheMoneyBy >= marginalThreshold) {
          const shares = leg.quantity * leg.multiplier;
          sharesDelta = leg.optionType === "put" ? shares : -shares;
          if (leg.optionType === "put") {
            acquiredShares = shares;
            acquiredCost = shares * leg.strike;
          }
        }
      }
    }
    events.push({ at: leg.exitAt.getTime(), sharesDelta, openOptionsDelta: -1, acquiredShares, acquiredCost });
  }

  events.sort((a, b) => a.at - b.at);

  let shares = 0;
  let openOptions = 0;
  let cycleStartAt = -Infinity;
  let index = 0;
  while (index < events.length) {
    let groupEnd = index;
    while (groupEnd + 1 < events.length && events[groupEnd + 1]!.at - events[groupEnd]!.at <= groupingWindowMs) groupEnd += 1;
    const wasFlat = shares === 0 && openOptions === 0;
    for (let i = index; i <= groupEnd; i += 1) {
      shares += events[i]!.sharesDelta;
      openOptions += events[i]!.openOptionsDelta;
    }
    const isFlat = shares === 0 && openOptions === 0;
    if (wasFlat && !isFlat) cycleStartAt = events[index]!.at;
    if (isFlat) cycleStartAt = -Infinity;
    index = groupEnd + 1;
  }
  if (cycleStartAt === -Infinity) return null;

  const cycleEvents = events.filter((event) => event.at >= cycleStartAt);
  const sharesHeld = cycleEvents.reduce((sum, event) => sum + event.sharesDelta, 0);
  const sharesAcquired = cycleEvents.reduce((sum, event) => sum + event.acquiredShares, 0);
  const acquisitionCost = cycleEvents.reduce((sum, event) => sum + event.acquiredCost, 0);

  const cycleOptionLegs = optionLegs.filter((leg) => leg.entryAt.getTime() >= cycleStartAt);
  let netPremium = 0;
  for (const leg of cycleOptionLegs) {
    const sign = leg.side === "short" ? 1 : -1;
    const contractShares = leg.quantity * leg.multiplier;
    netPremium += sign * leg.entryPrice * contractShares;
    if (leg.exitAt !== null && leg.exitPrice !== null) netPremium -= sign * leg.exitPrice * contractShares;
    netPremium -= leg.closingCommission;
  }

  const openShortPuts = cycleOptionLegs
    .filter((leg) => leg.side === "short" && leg.optionType === "put" && leg.exitAt === null)
    .map((leg) => ({ positionId: leg.positionId, strike: leg.strike, shares: leg.quantity * leg.multiplier }));
  const openShortPutShares = openShortPuts.reduce((sum, put) => sum + put.shares, 0);

  if (sharesHeld !== openStockShares) {
    unavailableReason ??= `ledger says ${sharesHeld} sh held but the open stock legs total ${openStockShares} sh`;
  }

  let breakEvenPerShare: number | null = null;
  if (unavailableReason === null) {
    if (sharesHeld > 0 && sharesAcquired > 0) breakEvenPerShare = (acquisitionCost - netPremium) / sharesAcquired;
    else if (openShortPutShares === 0) unavailableReason = "no shares or open short put in the cycle";
  }

  return { sharesHeld, sharesAcquired, acquisitionCost, netPremium, breakEvenPerShare, unavailableReason, openShortPuts };
}

/** Break-even for one open position: the cycle's per-share figure, or (put-only cycle) that position's own put strike - premium per put share. */
export function breakEvenForPosition(summary: OpenCycleSummary, positionId: string): { breakEven: number | null; reason: string | null } {
  if (summary.unavailableReason !== null) return { breakEven: null, reason: summary.unavailableReason };
  if (summary.sharesHeld > 0) return { breakEven: summary.breakEvenPerShare, reason: null };
  const putShares = summary.openShortPuts.reduce((sum, put) => sum + put.shares, 0);
  const ownPut = summary.openShortPuts.find((put) => put.positionId === positionId);
  if (!ownPut || putShares === 0) return { breakEven: null, reason: "no open short put on this position" };
  return { breakEven: ownPut.strike - summary.netPremium / putShares, reason: null };
}
