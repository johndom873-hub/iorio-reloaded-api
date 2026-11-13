import type { BookKey } from "../books/bookKeys.js";
import type { Cycle, CycleBucket, CycleInput } from "./cycles.js";

// The P&L Analyser's attribution (formulas approved by Marcelo 2026-11-13). Each night, every ticker's cycles are derived
// as the ledger stood at the end of that day (truncateCycleInputAsOf), and each strategy bucket's lifetime figures are
// stored: its option and stock P&L before commissions, the commissions, what is still open (unrealized) and the capital in
// use that night. A night's P&L is the change since the previous night, and it belongs to the book the ticker was in when
// the night's values were taken, about 17:30 ET (a hedge always Manual's), so the books' strategy figures add up with their
// nightly values. A ticker moved between the books during a night splits it at the move (pnl_attribution_move_snapshots):
// the book it left gets the change from the previous night to the move, its open legs at their move marks, the book it
// joined the rest; the night's capital-days split by the share of the night before and after the move.
// Example: 100 WDC shares at $287.73 the night before, moved to Pluto at $309.50, $301.20 at the snapshot → Manual
// +$2,177.00, Pluto −$830.00.
//
//   premiumGross  option rows' P&L before their commissions (CSP: put premium, CC: call premium, LEAPS, Hedge)
//   stockGross    stock rows' P&L before their commissions (CSP: the assignment charge, N/S and CC: the shares)
//   commissions   the commissions inside those rows, negative; premiumGross + stockGross + commissions = the bucket total
//   capital       in use that night: CSP strike × shares of its open puts, LEAPS and Hedge what their open options cost,
//                 CC and N/S the value of the shares still held when they entered the bucket (the cycles' own convention)
//
// Example: a put sold for $250 with $1.05 commission and bought back for $40 with $1.05 → premiumGross +$210.00 (250 − 40),
// commissions −$2.10, total +$207.90. A cycle with data flags is left out of the buckets and its total is kept apart
// (flaggedTotal), so the analyser can name it inside the gap to the book's value instead of guessing.

export const attributionBuckets: readonly CycleBucket[] = ["csp", "unstructured", "cc", "hedge", "leaps"];

export interface BucketAttribution {
  premiumGross: number;
  stockGross: number;
  commissions: number;
  total: number;
  unrealized: number;
  capital: number;
  /** Total of the bucket in cycles left out for their data flags. */
  flaggedTotal: number;
  flagReasons: string[];
}

export function emptyBucketAttribution(): BucketAttribution {
  return { premiumGross: 0, stockGross: 0, commissions: 0, total: 0, unrealized: 0, capital: 0, flaggedTotal: 0, flagReasons: [] };
}

function attributeCycleRows(cycle: Cycle, buckets: Record<CycleBucket, BucketAttribution>): void {
  for (const row of cycle.timeline) {
    const bucket = buckets[row.bucket];
    const commission = row.commission ?? 0;
    // The commission is inside the row's premium when it has one (an option fill), else inside its stock figure (a stock
    // fill, an assignment). A share purchase's row is $0 with its commission inside the shares' cost, realised later by
    // their sale or mark, which every later night includes.
    if (row.premium !== 0) {
      bucket.premiumGross += row.premium + commission;
      bucket.stockGross += row.stock;
    } else {
      bucket.premiumGross += row.premium;
      bucket.stockGross += row.stock + commission;
    }
    bucket.commissions -= commission;
    if (row.at === null || row.unrealized === true) bucket.unrealized += row.premium + row.stock;
  }
}

/** Capital in use at the end of the input's day, by bucket: only the open cycle holds any (see the header). */
function openCycleCapital(cycle: Cycle, input: CycleInput, buckets: Record<CycleBucket, BucketAttribution>): void {
  if (cycle.status !== "open") return;
  for (const leg of input.optionLegs) {
    if (leg.exitAt !== null || leg.entryAt.getTime() < cycle.startAt.getTime()) continue;
    const shares = leg.quantity * leg.multiplier;
    if (leg.side === "short") {
      if (leg.optionType === "put") buckets.csp.capital += leg.strike * shares;
    } else {
      buckets[leg.leaps ? "leaps" : "hedge"].capital += leg.entryPrice * shares;
    }
  }
  for (const row of cycle.timeline) {
    if (row.at !== null || row.instrument !== "stock" || row.stockPrice === null) continue;
    if (row.bucket === "cc" || row.bucket === "unstructured") buckets[row.bucket].capital += row.quantity * row.stockPrice - row.stock;
  }
}

/** Pure: one ticker's lifetime attribution by bucket, from its cycles derived as of a night and that same truncated input. */
export function attributeTickerCycles(cycles: readonly Cycle[], input: CycleInput): Record<CycleBucket, BucketAttribution> {
  const buckets = Object.fromEntries(attributionBuckets.map((bucket) => [bucket, emptyBucketAttribution()])) as Record<CycleBucket, BucketAttribution>;
  for (const cycle of cycles) {
    if (cycle.dataFlags.length > 0) {
      for (const bucket of attributionBuckets) {
        buckets[bucket].flaggedTotal += cycle.buckets[bucket].total;
        if (cycle.buckets[bucket].total !== 0 || cycle.buckets[bucket].premium !== 0) buckets[bucket].flagReasons.push(cycle.dataFlags[0]!);
      }
      continue;
    }
    attributeCycleRows(cycle, buckets);
    openCycleCapital(cycle, input, buckets);
  }
  for (const bucket of attributionBuckets) buckets[bucket].total = buckets[bucket].premiumGross + buckets[bucket].stockGross + buckets[bucket].commissions;
  return buckets;
}

/** The book a bucket's night belongs to: a hedge is always Manual's, the rest follow the ticker's book that night. */
export function bucketBookAtNight(bucket: CycleBucket, tickerBookAtNight: BookKey): BookKey {
  return bucket === "hedge" ? "manual" : tickerBookAtNight;
}

/** True when a bucket has never held anything: such rows are not stored. */
export function isEmptyBucketAttribution(attribution: BucketAttribution): boolean {
  return (
    attribution.premiumGross === 0 &&
    attribution.stockGross === 0 &&
    attribution.commissions === 0 &&
    attribution.unrealized === 0 &&
    attribution.capital === 0 &&
    attribution.flaggedTotal === 0
  );
}

/**
 * Pure: a night's span split at the moves between the books that fall in it (see the header). Each segment runs from one
 * point to the next, `before` (the previous night) to the first move's figures, ..., the last move's to `now`, in the book
 * the ticker was in during it, with its share of the night's time (for the capital-days). A hedge never moves.
 * Example: a move at 10:23 ET between captures at 17:30 ET → [Manual, before → at the move, 16.9 h of 24 h], [Pluto, at the move → now].
 */
export function splitNightAtMoves<T>(bucket: CycleBucket, before: T | undefined, now: T | undefined, nightBook: BookKey, moves: readonly { atMove: T | undefined; movedAt: Date; fromBook: BookKey }[], night: { startsAt: Date; endsAt: Date }): { book: BookKey; from: T | undefined; to: T | undefined; timeShare: number }[] {
  if (bucket === "hedge" || moves.length === 0) return [{ book: nightBook, from: before, to: now, timeShare: 1 }];
  const sorted = [...moves].sort((first, second) => first.movedAt.getTime() - second.movedAt.getTime());
  const times = [night.startsAt.getTime(), ...sorted.map((move) => move.movedAt.getTime()), night.endsAt.getTime()];
  const span = Math.max(times.at(-1)! - times[0]!, 1);
  return times.slice(0, -1).map((startMs, index) => ({
    book: index < sorted.length ? sorted[index]!.fromBook : nightBook,
    from: index === 0 ? before : sorted[index - 1]!.atMove,
    to: index < sorted.length ? sorted[index]!.atMove : now,
    timeShare: Math.min(Math.max((times[index + 1]! - startMs) / span, 0), 1),
  }));
}
