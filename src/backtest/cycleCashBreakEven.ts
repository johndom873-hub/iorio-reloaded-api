import type { BacktestCycleTimelineRow } from "./backtestTypes.js";

// An open cycle's cash break-even read back from its stored timeline (Marcelo 2026-10-20, the Wheel cycles' Break-even):
// (cost of every share bought in the cycle − what the shares that left brought in − net premium) ÷ shares held, the
// measure the baseline's call floor uses (cycleBreakEven.ts cashBreakEvenPerShare). The timeline's dollars are the same on
// any price scale, and its mark rows hold the shares still held on the last day's, so the result is as traded then.
//
// Each row's shares are as traded on its own day, so a count across a split puts them on one scale first (Marcelo
// 2026-10-21): split-adjusted shares = shares as traded × the day's split factor (as traded = split-adjusted × factor for
// a price). Example: 100 NFLX shares bought before its 10-for-1 split (factor 10) are 1,000 split-adjusted shares, and
// 1,000 as traded after it (factor 1).

/** Whether a timeline row brings shares into the cycle (+1), takes them out of it (−1) or neither (0), by its label. */
export function shareDirectionOf(label: string): 1 | -1 | 0 {
  if (label === "Bought shares" || label.startsWith("Put assigned")) return 1;
  if (label === "Sold shares" || label.startsWith("Call assigned")) return -1;
  return 0;
}

/**
 * A row's part in the cash break-even: dollars into and out of shares, premium, and shares in or out (as traded on its day).
 * `hedgeRealized` is what a hedge row adds: its realized P&L with the hedge in the break-even, else nothing.
 */
function rowAmounts(row: BacktestCycleTimelineRow, hedgeRealized = 0, optionPremiumsIncluded = true): { acquired: number; disposed: number; premium: number; shares: number } {
  const dollars = row.quantity * (row.label.startsWith("Put assigned") || row.label.startsWith("Call assigned") ? (row.strike ?? 0) : (row.stockPrice ?? 0));
  const commission = row.commissionDollars ?? 0;
  const bought = shareDirectionOf(row.label) === 1;
  const left = shareDirectionOf(row.label) === -1;
  // A hedge's cost is not premium earned on the shares; an open option's mark is not premium received.
  const premium = row.bucket === "hedge" ? hedgeRealized : optionPremiumsIncluded && !(row.at === null && row.label.startsWith("Open ")) ? row.premiumDollars : 0;
  return { acquired: bought ? dollars + commission : 0, disposed: left ? dollars - commission : 0, premium, shares: bought ? row.quantity : left ? -row.quantity : 0 };
}

/**
 * With the hedge's realized P&L in the break-even (baseline hedgeInBreakEven "included", Marcelo 2026-10-22), each hedge
 * row's part: a Put sale counts what it brought less what the Puts it sold cost (their purchases of the same contract,
 * oldest first, by split-adjusted shares); a purchase and a mark count nothing. Without it, every row's part is 0.
 */
function hedgeRealizedByRow(timeline: readonly BacktestCycleTimelineRow[], included: boolean, splitFactorOf: SplitFactorOfDay): number[] {
  if (!included) return timeline.map(() => 0);
  const purchasesByContract = new Map<string, { adjustedShares: number; cost: number }[]>();
  return timeline.map((row) => {
    if (row.bucket !== "hedge" || row.at === null || row.strike === null) return 0;
    const factor = splitFactorOf(row.tradingDate);
    // The strike split-adjusted (as traded ÷ the factor, prices going the other way from shares).
    const key = `${row.expiryDate}|${Math.round((row.strike / factor) * 10_000) / 10_000}`;
    const adjustedShares = row.quantity * factor;
    const purchases = purchasesByContract.get(key) ?? purchasesByContract.set(key, []).get(key)!;
    // Puts kept between cycles (hedgePutTurnover) leave a cycle as a sale at their mark and join the next as a purchase.
    if (row.label.startsWith("Bought put") || row.label.startsWith("Put from the kept ones")) {
      purchases.push({ adjustedShares, cost: -row.premiumDollars });
      return 0;
    }
    if (!row.label.startsWith("Sold put") && !row.label.startsWith("Put kept for the next entry")) return 0;
    let left = adjustedShares;
    let cost = 0;
    while (left > 1e-9 && purchases.length > 0) {
      const oldest = purchases[0]!;
      const taken = Math.min(left, oldest.adjustedShares);
      const takenCost = (oldest.cost * taken) / oldest.adjustedShares;
      cost += takenCost;
      oldest.cost -= takenCost;
      oldest.adjustedShares -= taken;
      left -= taken;
      if (oldest.adjustedShares <= 1e-9) purchases.shift();
    }
    return row.premiumDollars - cost;
  });
}

/**
 * How a timeline is read for the break-even: the hedge's realized P&L in it or not (hedgeInBreakEven), and the other
 * options' premium (false: a Vol Farmer whose hedge rule leaves the Calls out, Marcelo 2026-10-27).
 */
export interface CashBreakEvenOptions {
  hedgeRealizedPnlIncluded?: boolean;
  optionPremiumsIncluded?: boolean;
}

/** A day's split factor (1 where no split is known): the shares as traded that day × it are split-adjusted shares. */
export type SplitFactorOfDay = (tradingDate: string) => number;

const noSplits: SplitFactorOfDay = () => 1;

/** The shares the cycle holds at its last marks, as traded on the last day; 0 without mark rows (a closed cycle). */
export function sharesHeldAtMarks(timeline: readonly BacktestCycleTimelineRow[]): number {
  return timeline.reduce((sum, row) => sum + (row.label.startsWith("Marked to the ") ? row.quantity : 0), 0);
}

/** Null when the cycle holds no shares (or the timeline has no mark row of them). */
export function cycleCashBreakEven(timeline: readonly BacktestCycleTimelineRow[], splitFactorOf: SplitFactorOfDay = noSplits, options: CashBreakEvenOptions = {}): number | null {
  const hedgeRealized = hedgeRealizedByRow(timeline, options.hedgeRealizedPnlIncluded === true, splitFactorOf);
  let net = 0;
  for (const [index, row] of timeline.entries()) {
    const amounts = rowAmounts(row, hedgeRealized[index], options.optionPremiumsIncluded !== false);
    net += amounts.acquired - amounts.disposed - amounts.premium;
  }
  const sharesHeld = sharesHeldAtMarks(timeline);
  return sharesHeld > 0 ? net / sharesHeld : null;
}

/** Rows of one moment (one look's orders, or the end's marks) share an index: each row's moment, in timeline order. */
function momentIndexes(timeline: readonly BacktestCycleTimelineRow[]): number[] {
  let index = -1;
  return timeline.map((row, position) => {
    if (position === 0 || row.at !== timeline[position - 1]!.at) index += 1;
    return index;
  });
}

/**
 * The cash break-even just before each row's moment: what the shares then held had to bring for the cycle to end flat (null
 * while it held none), per share as traded on the row's day. Rows of one moment (one look's sales) share the value from
 * before it, as the engine checks every call of a look against one floor: before a call sold on held shares, the floor it
 * was held to (engine version 3 on).
 */
export function cashBreakEvenBeforeEachRow(timeline: readonly BacktestCycleTimelineRow[], splitFactorOf: SplitFactorOfDay = noSplits, options: CashBreakEvenOptions = {}): (number | null)[] {
  const moments = momentIndexes(timeline);
  const hedgeRealized = hedgeRealizedByRow(timeline, options.hedgeRealizedPnlIncluded === true, splitFactorOf);
  // A look's hedge sales come before its option sales (backtestBaselineHedge.ts): their gain is in the floor those sales see.
  const hedgeRealizedByMoment = new Map<number, number>();
  hedgeRealized.forEach((amount, position) => {
    if (amount !== 0) hedgeRealizedByMoment.set(moments[position]!, (hedgeRealizedByMoment.get(moments[position]!) ?? 0) + amount);
  });
  let net = 0;
  let adjustedShares = 0;
  let atMomentStart: { net: number; adjustedShares: number } = { net: 0, adjustedShares: 0 };
  return timeline.map((row, position) => {
    if (position === 0 || moments[position] !== moments[position - 1]) atMomentStart = { net: net - (hedgeRealizedByMoment.get(moments[position]!) ?? 0), adjustedShares };
    const amounts = rowAmounts(row, hedgeRealized[position], options.optionPremiumsIncluded !== false);
    net += amounts.acquired - amounts.disposed - amounts.premium;
    adjustedShares += amounts.shares * splitFactorOf(row.tradingDate);
    const sharesOnRowDay = atMomentStart.adjustedShares / splitFactorOf(row.tradingDate);
    return sharesOnRowDay > 1e-9 ? atMomentStart.net / sharesOnRowDay : null;
  });
}

/** The shares held once each row's moment is done (Marcelo 2026-10-21, the Wheel cycles' Shares), as traded on the row's day. */
export function sharesHeldAfterEachMoment(timeline: readonly BacktestCycleTimelineRow[], splitFactorOf: SplitFactorOfDay = noSplits): number[] {
  const moments = momentIndexes(timeline);
  const adjustedAfterMoment: number[] = [];
  let adjustedShares = 0;
  timeline.forEach((row, position) => {
    adjustedShares += rowAmounts(row).shares * splitFactorOf(row.tradingDate);
    adjustedAfterMoment[moments[position]!] = adjustedShares;
  });
  return timeline.map((row, position) => Math.round((adjustedAfterMoment[moments[position]!]! / splitFactorOf(row.tradingDate)) * 1e6) / 1e6);
}

/**
 * The shares the cycle held at an instant (a row at it counted), as traded on `tradingDate`: Marcelo 2026-10-21, a
 * stock-only stretch's shares read from the cycle's own trades. The ledger's stock legs could not give them: shares a later
 * assignment added to a lot already held were recorded on that lot's leg from its start.
 */
export function sharesHeldAtInstant(timeline: readonly BacktestCycleTimelineRow[], atMs: number, tradingDate: string, splitFactorOf: SplitFactorOfDay = noSplits): number {
  let adjustedShares = 0;
  for (const row of timeline) if (row.at !== null && new Date(row.at).getTime() <= atMs) adjustedShares += shareDirectionOf(row.label) * row.quantity * splitFactorOf(row.tradingDate);
  return Math.round((adjustedShares / splitFactorOf(tradingDate)) * 1e6) / 1e6;
}
