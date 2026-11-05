import { tickerPotShare } from "../../lib/tickerAllocation.js";
import type { BacktestVolFarmerV4Settings } from "../backtestTypes.js";
import { lotDollarsAt } from "./analysisSuitabilityRule.js";
import { median } from "./analysisPriceFigures.js";

// What pot fits Vol Farmer v4 on a ticker (F2–F4 for v4, approved by Marcelo 2026-11-01), every price as traded and a lot
// costing 100 × the 10:00 price + $0.50 of commission; 80% is the first position's share of the pot and 1.2 the pot's of the
// account with one ticker, at the lab's values (firstPositionPct 80, excessAllowancePct 20):
// - F2 smallest pot = one lot at the highest 10:00 price of the last 12 months ÷ 80%; with one ticker the account it needs
//   is that ÷ 1.2 (the pot is 1.2× the account).
// - F3 share of the target reached at pot P: lots = floor(80% of P ÷ a lot), share = lots × a lot ÷ 80% of P.
// - F4 largest pot by Call size: on each expiry day, L = the most lots any Call v4 could sell (F5) has bid size for (its
//   limit, the bid size of its 10:00 quote), and that day's largest pot = L × a lot ÷ 80%; the figure is the largest
//   pot that fits on at least 80% of the last 12 months' expiry days.

/** With one ticker the pot is the account × (100% + the excess allowance): 1.2 at 20%. */
export const oneTickerPotShareOfAccount = (v4: Pick<BacktestVolFarmerV4Settings, "excessAllowancePct">) => tickerPotShare(100, v4.excessAllowancePct, 100);
/** F4's share of expiry days a pot must fit on. */
export const largestPotDayShare = 0.8;

/** F2. */
export function smallestPotFor(highestPriceAsTraded: number, firstPositionShare: number, potShareOfAccount: number): { potDollars: number; accountDollars: number } {
  const potDollars = lotDollarsAt(highestPriceAsTraded) / firstPositionShare;
  return { potDollars, accountDollars: potDollars / potShareOfAccount };
}

export interface TargetReached {
  lots: number;
  lotDollars: number;
  sharesDollars: number;
  targetDollars: number;
  /** sharesDollars ÷ targetDollars. */
  shareOfTarget: number;
}

/** F3 at one price. */
export function targetReachedAt(potDollars: number, priceAsTraded: number, firstPositionShare: number): TargetReached {
  const lotDollars = lotDollarsAt(priceAsTraded);
  const targetDollars = firstPositionShare * potDollars;
  const lots = Math.floor(targetDollars / lotDollars + 1e-9);
  return { lots, lotDollars, sharesDollars: lots * lotDollars, targetDollars, shareOfTarget: (lots * lotDollars) / targetDollars };
}

/** F3 over the last 12 months' prices: the median share, and the range of what the whole lots cost. */
export function targetReachedOverDays(potDollars: number, pricesAsTraded: readonly number[], firstPositionShare: number): { medianShareOfTarget: number | null; sharesDollarsLow: number | null; sharesDollarsHigh: number | null } {
  const reached = pricesAsTraded.map((price) => targetReachedAt(potDollars, price, firstPositionShare));
  const sharesDollars = reached.map((entry) => entry.sharesDollars);
  return {
    medianShareOfTarget: median(reached.map((entry) => entry.shareOfTarget)),
    sharesDollarsLow: sharesDollars.length === 0 ? null : Math.min(...sharesDollars),
    sharesDollarsHigh: sharesDollars.length === 0 ? null : Math.max(...sharesDollars),
  };
}

/** F4 for one expiry day. */
export const largestPotOfDay = (lotsTheVolumeLimitCovers: number, priceAsTraded: number, firstPositionShare: number) => (lotsTheVolumeLimitCovers * lotDollarsAt(priceAsTraded)) / firstPositionShare;

/** F4's figure: the largest pot at most the day's own on at least 80% of the days (the ⌈0.8 × days⌉-th largest); null without days. */
export function potFittingDayShare(dayPots: readonly number[], dayShare = largestPotDayShare): number | null {
  if (dayPots.length === 0) return null;
  const descending = [...dayPots].sort((a, b) => b - a);
  return descending[Math.max(1, Math.ceil(dayShare * descending.length)) - 1]!;
}

/** The band v4 rebalances the first position to (F24): the target ± the band, as shares' dollars, and where whole lots fall in it. */
export function bandAt(potDollars: number, priceAsTraded: number, firstPositionShare: number, bandPct: number): { lots: number; sharesDollars: number; floorDollars: number; topDollars: number; oneMoreLotDollars: number } {
  const reached = targetReachedAt(potDollars, priceAsTraded, firstPositionShare);
  return {
    lots: reached.lots,
    sharesDollars: reached.sharesDollars,
    floorDollars: (firstPositionShare - bandPct / 100) * potDollars,
    topDollars: (firstPositionShare + bandPct / 100) * potDollars,
    oneMoreLotDollars: (reached.lots + 1) * reached.lotDollars,
  };
}
