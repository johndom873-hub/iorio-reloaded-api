// The portfolio simulator's pot table and suggested allocations (Marcelo 2026-11-03): v4 holds and trades shares in lots
// of 100, so what a pot can do depends on the stock's price. Pot = allocation × (1 + allowance) × account; a lot = 100 ×
// price + the stock commission. Example at $1,000,000 with a 20% allowance: XLE at $70.02 on 10% has a $120,000 pot; its
// 80% target ($96,000) buys floor(96,000 ÷ 7,002.50) = 13 lots ($91,032.50, 94.8% of the target); the 20% band ($24,000)
// spans 3.4 lots, so it can act: a top-up below 72,000 ÷ 1,300 = $55.38, a trim above 120,000 ÷ 1,300 = $92.31. The band
// acts once it spans a whole lot: a pot of at least lot × 100 ÷ band% (5 lots at 20%; AMD at $504.80: $252,402.50, 21.03%
// of the account's pots).

/** The most one ticker may take of the book (Marcelo 2026-11-03): a ticker whose floor is above it is too large for the account. */
export const maxAllocationPct = 25;

export function potDollarsOf(allocationPct: number, excessAllowancePct: number, accountDollars: number): number {
  return (allocationPct / 100) * (1 + excessAllowancePct / 100) * accountDollars;
}

export interface PotFigures {
  potDollars: number;
  lotDollars: number;
  targetDollars: number;
  /** floor(target ÷ a lot): the lots the First position holds. */
  lotsAtTarget: number;
  /** The share of the target those lots reach. */
  targetReached: number;
  bandDollars: number;
  /** The band in lots: below 1 it can never act (a top-up or trim needs a whole lot). */
  bandLots: number;
  bandActs: boolean;
  /** The price the holding would be topped up below, and trimmed above; null with no lot held. */
  topUpBelowPrice: number | null;
  trimAbovePrice: number | null;
  /** The smallest pot the First position holds one lot in: a lot ÷ First position %. */
  smallestOneLotPot: number;
  /** The smallest pot whose band spans a lot: lot × 100 ÷ band %. */
  smallestBandActingPot: number;
}

export function potFiguresOf(input: { potDollars: number; price: number; stockCommissionDollars: number; firstPositionPct: number; rebalanceBandPct: number }): PotFigures {
  const { potDollars, price, firstPositionPct, rebalanceBandPct } = input;
  const lotDollars = 100 * price + input.stockCommissionDollars;
  const targetDollars = (potDollars * firstPositionPct) / 100;
  const lotsAtTarget = Math.floor(targetDollars / lotDollars + 1e-9);
  const bandDollars = (potDollars * rebalanceBandPct) / 100;
  const bandLots = bandDollars / lotDollars;
  return {
    potDollars,
    lotDollars,
    targetDollars,
    lotsAtTarget,
    targetReached: targetDollars > 0 ? (lotsAtTarget * lotDollars) / targetDollars : 0,
    bandDollars,
    bandLots,
    bandActs: bandLots >= 1,
    topUpBelowPrice: lotsAtTarget > 0 ? (targetDollars - bandDollars) / (lotsAtTarget * 100) : null,
    trimAbovePrice: lotsAtTarget > 0 ? (targetDollars + bandDollars) / (lotsAtTarget * 100) : null,
    smallestOneLotPot: lotDollars / (firstPositionPct / 100),
    smallestBandActingPot: (lotDollars * 100) / rebalanceBandPct,
  };
}

/** A ticker's floor: the allocation whose pot is its smallest band-acting pot, % of the account's pots before the allowance. */
export function floorAllocationPctOf(smallestBandActingPot: number, excessAllowancePct: number, accountDollars: number): number {
  return (smallestBandActingPot / ((1 + excessAllowancePct / 100) * accountDollars)) * 100;
}

export interface SuggestedAllocations {
  /** Each ticker's allocation, %: max(floor, s), s the share the rest get, none above the cap. */
  allocationPctBySymbol: Map<string, number>;
  /** s: what a ticker whose floor is lower gets. */
  equalSharePct: number;
  /** Tickers whose floor is above the cap: too large for this account, left out. */
  tooLarge: { symbol: string; floorPct: number }[];
  /** The floors of the tickers kept add up to more than 100%: some must go (the caller ranks which). */
  floorsOverFull: boolean;
  /** What no ticker takes, when every one is at the cap: 100% less the allocations. */
  unallocatedPct: number;
}

/**
 * The suggested allocations (approved 2026-11-03): each ticker at least its floor, the others an equal share s chosen so
 * the allocations add up to 100% (max(floor, s)), a ticker whose floor is above the cap left out as too large, s itself at
 * most the cap (a few tickers leave the rest unallocated). Ten tickers with AMD (floor 21.03%) and nine whose floors fit:
 * AMD 21.03%, the nine (100 − 21.03) ÷ 9 = 8.77% each.
 */
export function suggestAllocations(floors: readonly { symbol: string; floorPct: number }[], capPct = maxAllocationPct): SuggestedAllocations {
  const tooLarge = floors.filter((entry) => entry.floorPct > capPct);
  const kept = floors.filter((entry) => entry.floorPct <= capPct);
  const floorsTotal = kept.reduce((sum, entry) => sum + entry.floorPct, 0);
  if (kept.length === 0 || floorsTotal > 100 + 1e-9) {
    return { allocationPctBySymbol: new Map(kept.map((entry) => [entry.symbol, entry.floorPct])), equalSharePct: 0, tooLarge, floorsOverFull: kept.length > 0, unallocatedPct: Math.max(0, 100 - floorsTotal) };
  }
  // Water-filling: those whose floor is above s keep it; the rest share what is left equally.
  const byFloorDescending = [...kept].sort((a, b) => b.floorPct - a.floorPct);
  let fixedTotal = 0;
  let fixedCount = 0;
  let share = 100 / kept.length;
  while (fixedCount < byFloorDescending.length && byFloorDescending[fixedCount]!.floorPct > share) {
    fixedTotal += byFloorDescending[fixedCount]!.floorPct;
    fixedCount += 1;
    share = fixedCount === byFloorDescending.length ? 0 : (100 - fixedTotal) / (byFloorDescending.length - fixedCount);
  }
  share = Math.min(share, capPct);
  const allocationPctBySymbol = new Map(kept.map((entry) => [entry.symbol, Math.max(entry.floorPct, share)]));
  const total = [...allocationPctBySymbol.values()].reduce((sum, pct) => sum + pct, 0);
  return { allocationPctBySymbol, equalSharePct: share, tooLarge, floorsOverFull: false, unallocatedPct: Math.max(0, 100 - total) };
}
