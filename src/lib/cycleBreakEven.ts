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
//                           in the money per the expiry-date daily close)
//   call assigned        -> shares out at the strike (same test)
//                           IBKR's recorded stock fill of an assignment, when there is one, is
//                           absorbed by it (assignmentFillMatching.ts): not counted again, its
//                           commission added to a put's cost
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

import { matchAssignmentFills } from "./assignmentFillMatching.js";

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
  /** How the leg settled at expiry, when known rather than inferred (a simulated book); live leaves it unset (see cycles.ts). */
  settledAs?: OptionSettlementOutcome;
  /** positions.close_reason for this leg's own position. Not read by the ledger: an assignment's recorded fill is
   * recognised by what it is (assignmentFillMatching.ts), whatever reason reconciliation stamped. */
  positionCloseReason: string | null;
}

export type OptionSettlementOutcome = "assigned" | "worthless";

export interface CycleStockTrade {
  at: Date;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  commission: number;
  /** The position whose stock leg holds the fill, for each position's own break-even (breakEvenByPositionFromHistory). */
  positionId?: string;
}

/** What one position added to the open cycle: the amounts its own legs and fills put into the cycle's break-even. */
export interface PositionCycleContribution {
  sharesAcquired: number;
  acquisitionCost: number;
  netPremium: number;
}

export interface OpenCycleSummary {
  sharesHeld: number;
  sharesAcquired: number;
  /** Cost of every share acquired in the cycle (fills + commission, assigned puts at the strike). */
  acquisitionCost: number;
  netPremium: number;
  /** Per share held; null when it cannot be computed (see unavailableReason). */
  breakEvenPerShare: number | null;
  /** What the cycle received for shares that left it (sold, or called away at the strike), net of commission. */
  disposalProceeds: number;
  /**
   * The cash break-even per share held (approved 2026-10-20 for the backtest's call floor): (the cost of every share
   * acquired − what the shares that left brought in − net premium) ÷ shares held. Shares leaving at or above it leave the
   * cycle flat or better, whatever earlier shares left at. Null without shares held or when the ledger cannot be trusted.
   */
  cashBreakEvenPerShare: number | null;
  unavailableReason: string | null;
  /** Open short puts in the cycle, for the put-only (no shares yet) break-even of each position. */
  openShortPuts: { positionId: string; strike: number; shares: number }[];
  /** The cycle's amounts by the position they came from; a fill with no position is under "". They add up to the totals above. */
  contributionsByPositionId: Map<string, PositionCycleContribution>;
}

const groupingWindowMs = 120_000;
const marginalThreshold = 0.05;

interface LedgerEvent {
  at: number;
  sharesDelta: number;
  openOptionsDelta: number;
  acquiredShares: number;
  acquiredCost: number;
  /** Cash from shares that left: a sale's proceeds, or a call assignment's at the strike (its fill when recorded), net of commission. */
  disposalProceeds: number;
  positionId: string;
}

function isSettledWithoutTrade(leg: CycleOptionLeg): boolean {
  return leg.side === "short" && leg.exitAt !== null && !leg.hasClosingTrade && (leg.exitPrice === 0 || leg.exitPrice === null);
}

function inTheMoneyBy(leg: CycleOptionLeg, settlementClose: number): number {
  return leg.optionType === "call" ? settlementClose - leg.strike : leg.strike - settlementClose;
}

/** Whether the ledger books the leg as assigned: settled without a trade, assigned by its explicit settlement, else in the money by the threshold at the settlement close. */
export function settlesAssigned(leg: CycleOptionLeg): boolean {
  if (!isSettledWithoutTrade(leg)) return false;
  if (leg.settledAs !== undefined) return leg.settledAs === "assigned";
  return leg.expiryClose !== null && inTheMoneyBy(leg, leg.expiryClose) >= marginalThreshold;
}

/** Summary of the symbol's currently open cycle, or null when the symbol is flat. */
export function summarizeOpenCycle(
  optionLegs: CycleOptionLeg[],
  stockTrades: CycleStockTrade[],
  openStockShares: number,
): OpenCycleSummary | null {
  let unavailableReason: string | null = null;
  const events: LedgerEvent[] = [];

  // IBKR reports an assignment as an ordinary stock execution at the strike, which the worker records like any other
  // fill, while the ledger also infers the assignment from the leg. A fill that matches an inferred assignment
  // (assignmentFillMatching.ts, the rule deriveCycles uses too) is absorbed by it: it leaves the fills, and the assignment
  // takes its price and commission. An assignment with no recorded fill brings its shares in or out at the strike.
  const fillIndexByAssignedLegId = matchAssignmentFills(optionLegs.filter(settlesAssigned), stockTrades);
  const absorbedFillIndices = new Set(fillIndexByAssignedLegId.values());

  stockTrades.forEach((trade, tradeIndex) => {
    if (absorbedFillIndices.has(tradeIndex)) return;
    const signedShares = trade.side === "buy" ? trade.quantity : -trade.quantity;
    const isBuy = trade.side === "buy";
    events.push({ at: trade.at.getTime(), sharesDelta: signedShares, openOptionsDelta: 0, acquiredShares: isBuy ? trade.quantity : 0, acquiredCost: isBuy ? trade.quantity * trade.price + trade.commission : 0, disposalProceeds: isBuy ? 0 : trade.quantity * trade.price - trade.commission, positionId: trade.positionId ?? "" });
  });

  for (const leg of optionLegs) {
    events.push({ at: leg.entryAt.getTime(), sharesDelta: 0, openOptionsDelta: 1, acquiredShares: 0, acquiredCost: 0, disposalProceeds: 0, positionId: leg.positionId });
    if (leg.exitAt === null) continue;
    let sharesDelta = 0;
    let acquiredShares = 0;
    let acquiredCost = 0;
    let disposalProceeds = 0;
    let acquiredByPositionId = leg.positionId;
    // An explicit settlement (a simulated book) needs no bar and no threshold; an inferred one refuses what it cannot tell.
    if (isSettledWithoutTrade(leg) && leg.settledAs === undefined) {
      if (leg.expiryClose === null) unavailableReason ??= `no expiry-date price bar for ${leg.optionType} $${leg.strike} (${leg.expiryDate})`;
      else {
        const inTheMoneyAtSettlement = inTheMoneyBy(leg, leg.expiryClose);
        if (inTheMoneyAtSettlement > 0 && inTheMoneyAtSettlement < marginalThreshold) unavailableReason ??= `${leg.optionType} $${leg.strike} (${leg.expiryDate}) expired within $${marginalThreshold} of the strike — assignment unclear`;
      }
    }
    if (settlesAssigned(leg)) {
      const shares = leg.quantity * leg.multiplier;
      sharesDelta = leg.optionType === "put" ? shares : -shares;
      if (leg.optionType === "put") {
        const fillIndex = fillIndexByAssignedLegId.get(leg.id);
        const fill = fillIndex === undefined ? undefined : stockTrades[fillIndex]!;
        acquiredShares = shares;
        acquiredCost = fill === undefined ? shares * leg.strike : fill.quantity * fill.price + fill.commission;
        // The cost goes to the position whose stock leg holds the fill, where the shares landed: each position's own
        // break-even (breakEvenByPositionFromHistory) then finds it in the receiving position's history even when the
        // put's hand-over link (position_share_sources) is missing. With no fill, or a fill with no position, it stays
        // with the put.
        if (fill?.positionId !== undefined) acquiredByPositionId = fill.positionId;
      } else {
        const fillIndex = fillIndexByAssignedLegId.get(leg.id);
        const fill = fillIndex === undefined ? undefined : stockTrades[fillIndex]!;
        disposalProceeds = fill === undefined ? shares * leg.strike : fill.quantity * fill.price - fill.commission;
      }
    }
    events.push({ at: leg.exitAt.getTime(), sharesDelta, openOptionsDelta: -1, acquiredShares, acquiredCost, disposalProceeds, positionId: acquiredByPositionId });
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
  const disposalProceeds = cycleEvents.reduce((sum, event) => sum + event.disposalProceeds, 0);

  const contributionsByPositionId = new Map<string, PositionCycleContribution>();
  const contributionOf = (positionId: string) => {
    let contribution = contributionsByPositionId.get(positionId);
    if (!contribution) contributionsByPositionId.set(positionId, (contribution = { sharesAcquired: 0, acquisitionCost: 0, netPremium: 0 }));
    return contribution;
  };
  for (const event of cycleEvents) {
    if (event.acquiredShares === 0 && event.acquiredCost === 0) continue;
    const contribution = contributionOf(event.positionId);
    contribution.sharesAcquired += event.acquiredShares;
    contribution.acquisitionCost += event.acquiredCost;
  }

  const cycleOptionLegs = optionLegs.filter((leg) => leg.entryAt.getTime() >= cycleStartAt);
  let netPremium = 0;
  for (const leg of cycleOptionLegs) {
    // A long option (a hedge) keeps the cycle open while held, the way the Wheel card's cycle windows count it, but its
    // cost stays out of the wheel's premium and break-even.
    if (leg.side === "long") continue;
    const sign = leg.side === "short" ? 1 : -1;
    const contractShares = leg.quantity * leg.multiplier;
    let legPremium = sign * leg.entryPrice * contractShares;
    if (leg.exitAt !== null && leg.exitPrice !== null) legPremium -= sign * leg.exitPrice * contractShares;
    legPremium -= leg.closingCommission;
    netPremium += legPremium;
    contributionOf(leg.positionId).netPremium += legPremium;
  }

  const openShortPuts = cycleOptionLegs
    .filter((leg) => leg.side === "short" && leg.optionType === "put" && leg.exitAt === null)
    .map((leg) => ({ positionId: leg.positionId, strike: leg.strike, shares: leg.quantity * leg.multiplier }));
  const openShortPutShares = openShortPuts.reduce((sum, put) => sum + put.shares, 0);

  if (sharesHeld !== openStockShares) {
    unavailableReason ??= `ledger says ${sharesHeld} sh held but the open stock legs total ${openStockShares} sh`;
  }

  let breakEvenPerShare: number | null = null;
  let cashBreakEvenPerShare: number | null = null;
  if (unavailableReason === null) {
    if (sharesHeld > 0 && sharesAcquired > 0) {
      breakEvenPerShare = (acquisitionCost - netPremium) / sharesAcquired;
      cashBreakEvenPerShare = (acquisitionCost - disposalProceeds - netPremium) / sharesHeld;
    } else if (openShortPutShares === 0) unavailableReason = "no shares or open short put in the cycle";
  }

  return { sharesHeld, sharesAcquired, acquisitionCost, netPremium, breakEvenPerShare, disposalProceeds, cashBreakEvenPerShare, unavailableReason, openShortPuts, contributionsByPositionId };
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

/** An open position, as breakEvenByPositionFromHistory needs it. */
export interface OpenPositionHoldings {
  positionId: string;
  sharesHeld: number;
}

/** A position that received shares from another (position_share_sources), with how many it received. */
export interface PositionShareSourceLink {
  positionId: string;
  sourcePositionId: string;
  sharesReceived: number;
}

/**
 * Each open position's own break-even (approved by Marcelo 2026-10-16), the Wheel cycle keeping the consolidated one:
 *   break-even = (cost - net premium) / shares acquired, over this position's history: itself and every position whose
 *   shares reached it (a roll, a leftover-stock position, the put that delivered them), each counted by the share of its
 *   shares that came here (split by shares received when a position handed shares to several);
 *   plus the cycle's amounts no open position's history reaches (a put that expired without delivering shares, shares
 *   bought and sold again), shared by shares held (by put shares while no position holds shares).
 * A ticker's only open position gets exactly the cycle's break-even. Several positions' break-evens, weighted by shares
 * held, average to the cycle's only when every open position holds shares and each one's shares acquired are the same
 * multiple of its shares held: not after a partial sale out of one position's shares, nor with an open cash-secured put
 * beside the shares (its premium stays with the put, outside the shares' average).
 * A position with only a put: its strike - net premium per put share.
 */
export function breakEvenByPositionFromHistory(
  summary: OpenCycleSummary,
  openPositions: OpenPositionHoldings[],
  shareSources: PositionShareSourceLink[],
): Map<string, { breakEven: number | null; reason: string | null }> {
  const result = new Map<string, { breakEven: number | null; reason: string | null }>();
  if (summary.unavailableReason !== null) {
    for (const position of openPositions) result.set(position.positionId, { breakEven: null, reason: summary.unavailableReason });
    return result;
  }

  const sourcesByPositionId = new Map<string, PositionShareSourceLink[]>();
  const sharesHandedOutBySourceId = new Map<string, number>();
  const receiversBySourceId = new Map<string, number>();
  for (const link of shareSources) {
    sourcesByPositionId.set(link.positionId, [...(sourcesByPositionId.get(link.positionId) ?? []), link]);
    sharesHandedOutBySourceId.set(link.sourcePositionId, (sharesHandedOutBySourceId.get(link.sourcePositionId) ?? 0) + Math.max(link.sharesReceived, 0));
    receiversBySourceId.set(link.sourcePositionId, (receiversBySourceId.get(link.sourcePositionId) ?? 0) + 1);
  }
  const shareOfSource = (link: PositionShareSourceLink) => {
    const handedOut = sharesHandedOutBySourceId.get(link.sourcePositionId) ?? 0;
    return handedOut > 0 ? Math.max(link.sharesReceived, 0) / handedOut : 1 / (receiversBySourceId.get(link.sourcePositionId) ?? 1);
  };

  // Every position in an open position's history, with the share of its amounts that belongs here.
  const historyWeights = (positionId: string): Map<string, number> => {
    const weights = new Map<string, number>([[positionId, 1]]);
    const visit = (currentId: string, weight: number, path: Set<string>) => {
      for (const link of sourcesByPositionId.get(currentId) ?? []) {
        if (path.has(link.sourcePositionId)) continue;
        const sourceWeight = weight * shareOfSource(link);
        weights.set(link.sourcePositionId, (weights.get(link.sourcePositionId) ?? 0) + sourceWeight);
        visit(link.sourcePositionId, sourceWeight, new Set([...path, link.sourcePositionId]));
      }
    };
    visit(positionId, 1, new Set([positionId]));
    return weights;
  };

  const zero = (): PositionCycleContribution => ({ sharesAcquired: 0, acquisitionCost: 0, netPremium: 0 });
  const addScaled = (target: PositionCycleContribution, source: PositionCycleContribution, scale: number) => {
    target.sharesAcquired += source.sharesAcquired * scale;
    target.acquisitionCost += source.acquisitionCost * scale;
    target.netPremium += source.netPremium * scale;
  };

  const amountsByPositionId = new Map<string, PositionCycleContribution>();
  const unattributed: PositionCycleContribution = { sharesAcquired: summary.sharesAcquired, acquisitionCost: summary.acquisitionCost, netPremium: summary.netPremium };
  for (const position of openPositions) {
    const amounts = zero();
    for (const [historyPositionId, weight] of historyWeights(position.positionId)) {
      const contribution = summary.contributionsByPositionId.get(historyPositionId);
      if (contribution) addScaled(amounts, contribution, weight);
    }
    amountsByPositionId.set(position.positionId, amounts);
    addScaled(unattributed, amounts, -1);
  }

  const putSharesByPositionId = new Map<string, number>();
  for (const put of summary.openShortPuts) putSharesByPositionId.set(put.positionId, (putSharesByPositionId.get(put.positionId) ?? 0) + put.shares);
  const totalSharesHeld = openPositions.reduce((sum, position) => sum + Math.max(position.sharesHeld, 0), 0);
  const totalPutShares = openPositions.reduce((sum, position) => sum + (putSharesByPositionId.get(position.positionId) ?? 0), 0);
  for (const position of openPositions) {
    const share = totalSharesHeld > 0 ? Math.max(position.sharesHeld, 0) / totalSharesHeld : totalPutShares > 0 ? (putSharesByPositionId.get(position.positionId) ?? 0) / totalPutShares : 0;
    addScaled(amountsByPositionId.get(position.positionId)!, unattributed, share);
  }

  for (const position of openPositions) {
    const amounts = amountsByPositionId.get(position.positionId)!;
    if (position.sharesHeld > 0) {
      result.set(
        position.positionId,
        amounts.sharesAcquired > 0 ? { breakEven: (amounts.acquisitionCost - amounts.netPremium) / amounts.sharesAcquired, reason: null } : { breakEven: null, reason: "no shares acquired in this position's history" },
      );
      continue;
    }
    const ownPut = summary.openShortPuts.find((put) => put.positionId === position.positionId);
    const putShares = putSharesByPositionId.get(position.positionId) ?? 0;
    result.set(position.positionId, ownPut && putShares > 0 ? { breakEven: ownPut.strike - amounts.netPremium / putShares, reason: null } : { breakEven: null, reason: "no shares or open short put on this position" });
  }
  return result;
}
