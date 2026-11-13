import { db } from "../db/connection.js";
import { deriveCycles, type Cycle, type CycleBucket, type CycleInput, type CycleLegOpeningFill, type CycleOptionLeg, type CycleStockLeg } from "./cycles.js";
import { loadCycleInputsForTickers } from "./cycleQueries.js";
import { easternInstant, previousOpenSessionDate } from "./marketSessionStatus.js";
import { easternTodaySql } from "./easternTodaySql.js";

// Dashboard "P&L by Period" / "P&L by Strategy (YTD)" on the fair cycle attribution (approved 2026-09-21; the same
// CSP / N/S / CC buckets as the Positions scoreboard, see cycles.ts).
//
//   period P&L(bucket)  = bucket total now - bucket total as of the period's baseline day
//   unrealized YTD      = the still-open marks now (rows with no date) - the same marks as of the baseline
//   realized YTD        = YTD P&L - unrealized YTD
//
// "As of" a day D = the same cycle derivation run on the ledger truncated at the end of D (Eastern): later fills are
// dropped, legs closed after D are open again, held shares are marked at D's daily close and open options at D's
// position_pnl_snapshots.premium_pnl. Everything not attributable is left to the caller's Residual: cycles with data
// flags are left out of the buckets, never guessed.
//
// Baselines follow the account-level card they must reconcile with (loadPeriodPnl in routes/dashboard.ts):
//   Day   = the last trading day before the latest account snapshot (the account's Day is that snapshot's daily P&L)
//   Week/Month/Year = the last trading day before this Monday / the 1st / Jan 1 (by today's ET date, as the account card does)

export type CyclePeriod = "day" | "week" | "month" | "year";
const cyclePeriods: CyclePeriod[] = ["day", "week", "month", "year"];

export interface BucketPeriodPnl {
  day: number;
  week: number;
  month: number;
  year: number;
  realizedYear: number;
  unrealizedYear: number;
}

export interface CyclePeriodPnl {
  buckets: Record<CycleBucket, BucketPeriodPnl>;
  /** Cycles that overlap the period but were left out of its buckets (their P&L falls into Residual). */
  excludedByPeriod: Record<CyclePeriod, { symbol: string; reason: string }[]>;
}

export interface SnapshotMarks {
  premiumPnl: number | null;
  unrealizedPnl: number;
}

// The boundaries are read in SQL (today's ET date, as the account card does); the previous trading day before each is resolved
// by the same walk the Dashboard's Day card uses, so a gap in market_calendar can never put the two on different days.
export async function loadBaselineDates(): Promise<Record<CyclePeriod, string> | null> {
  const result = await db.raw(`
    SELECT
      latest.d::text AS "latestSnapshotDate",
      date_trunc('week', ${easternTodaySql})::date::text AS "weekStart",
      date_trunc('month', ${easternTodaySql})::date::text AS "monthStart",
      date_trunc('year', ${easternTodaySql})::date::text AS "yearStart"
    FROM (SELECT MAX(snapshot_date) AS d FROM account_pnl_snapshots) latest
  `);
  const row = result.rows[0];
  if (!row || row.latestSnapshotDate === null) return null;
  const [day, week, month, year] = await Promise.all([
    previousOpenSessionDate(row.latestSnapshotDate),
    previousOpenSessionDate(row.weekStart),
    previousOpenSessionDate(row.monthStart),
    previousOpenSessionDate(row.yearStart),
  ]);
  return { day, week, month, year };
}

export async function loadSnapshotMarksOn(dateIso: string): Promise<Map<string, SnapshotMarks>> {
  return (await loadSnapshotMarksBetween(dateIso, dateIso)).get(dateIso) ?? new Map();
}

/** Every night's position marks from `firstDateIso` to `lastDateIso` (inclusive), by night then position id, in one query. */
export async function loadSnapshotMarksBetween(firstDateIso: string, lastDateIso: string): Promise<Map<string, Map<string, SnapshotMarks>>> {
  const result = await db.raw(
    `SELECT snapshot_date::text AS night, position_id AS "positionId", premium_pnl::float AS "premiumPnl", unrealized_pnl::float AS "unrealizedPnl"
     FROM position_pnl_snapshots WHERE snapshot_date BETWEEN ?::date AND ?::date`,
    [firstDateIso, lastDateIso],
  );
  const marksByNight = new Map<string, Map<string, SnapshotMarks>>();
  for (const row of result.rows as { night: string; positionId: string; premiumPnl: number | null; unrealizedPnl: number }[]) {
    const marks = marksByNight.get(row.night) ?? new Map<string, SnapshotMarks>();
    marks.set(row.positionId, { premiumPnl: row.premiumPnl, unrealizedPnl: row.unrealizedPnl });
    marksByNight.set(row.night, marks);
  }
  return marksByNight;
}

/**
 * The opening fills a leg received after the cutoff: IBKR adds later buys or sales of the same contract to the one leg, so
 * today's quantity and average cost are not the night's (SNXX LEAPS: 20 contracts on 2026-11-09, 80 from 11-10). The leg
 * as of the cutoff is today's less those fills, which also covers a leg whose first contracts came without a recorded fill.
 */
export function openingFillsAfter(leg: { openingFills?: CycleLegOpeningFill[] }, cutoffMs: number): CycleLegOpeningFill[] {
  return (leg.openingFills ?? []).filter((fill) => fill.at.getTime() > cutoffMs);
}

/**
 * An option leg as it stood at the cutoff: today's quantity less the later fills, at IBKR's average cost less theirs (the
 * average carries the commission: a bought option costs more, a sold one brings in less); null when it held none yet.
 * Example: 10 contracts at $5.3712 with 7 bought later at $5.53 ($3.78 commission) → 3 at (5,371.20 − 3,874.78) ÷ 300 = $4.988.
 */
function optionLegAsOf(leg: CycleOptionLeg, cutoffMs: number): CycleOptionLeg | null {
  const later = openingFillsAfter(leg, cutoffMs);
  if (later.length === 0) return leg;
  const laterQuantity = later.reduce((sum, fill) => sum + fill.quantity, 0);
  const quantity = leg.quantity - laterQuantity;
  if (quantity <= 0) return null;
  const laterCommission = later.reduce((sum, fill) => sum + fill.commission, 0);
  const laterFillValue = later.reduce((sum, fill) => sum + fill.price * fill.quantity * leg.multiplier, 0);
  const laterCost = laterFillValue + (leg.side === "long" ? laterCommission : -laterCommission);
  const entryPrice = (leg.entryPrice * leg.quantity * leg.multiplier - laterCost) / (quantity * leg.multiplier);
  return {
    ...leg,
    quantity,
    entryPrice,
    openingFills: (leg.openingFills ?? []).filter((fill) => fill.at.getTime() <= cutoffMs),
    ...(leg.openingFillCount === undefined ? {} : { openingFillCount: Math.max(leg.openingFillCount - later.length, 0) }),
    ...(leg.openingCommission == null ? {} : { openingCommission: Math.max(leg.openingCommission - laterCommission, 0) }),
    ...(leg.openingFillPrice == null ? {} : { openingFillPrice: (leg.openingFillPrice * leg.quantity * leg.multiplier - laterFillValue) / (quantity * leg.multiplier) }),
  };
}

function stockLegAsOf(leg: CycleStockLeg, cutoffMs: number): CycleStockLeg | null {
  const later = openingFillsAfter(leg, cutoffMs);
  if (later.length === 0) return leg;
  const quantity = leg.quantity - later.reduce((sum, fill) => sum + fill.quantity, 0);
  return quantity <= 0 ? null : { ...leg, quantity, openingFills: (leg.openingFills ?? []).filter((fill) => fill.at.getTime() <= cutoffMs) };
}

/** The ledger as it stood at the end of baselineDate (Eastern). Exported for tests. */
export function truncateCycleInputAsOf(input: CycleInput, baselineDate: string, snapshotMarks: Map<string, SnapshotMarks>): CycleInput {
  return truncateCycleInputAt(input, easternInstant(baselineDate, 23, 59).getTime() + 59_999, baselineDate, snapshotMarks);
}

/** The ledger as it stood at `cutoffMs`, with the daily closes through `closesThroughDate` (its last one the mark). */
export function truncateCycleInputAt(input: CycleInput, cutoffMs: number, closesThroughDate: string, snapshotMarks: Map<string, SnapshotMarks>): CycleInput {
  const baselineDate = closesThroughDate;
  const optionLegs = input.optionLegs
    .filter((leg) => leg.entryAt.getTime() <= cutoffMs)
    .map((leg) => optionLegAsOf(leg, cutoffMs))
    .filter((leg): leg is CycleOptionLeg => leg !== null)
    .map((leg) => (leg.exitAt !== null && leg.exitAt.getTime() > cutoffMs ? { ...leg, exitAt: null, exitPrice: null, closingCommission: 0, hasClosingTrade: false } : leg));
  const stockLegs = input.stockLegs
    .filter((leg) => leg.entryAt.getTime() <= cutoffMs)
    .map((leg) => stockLegAsOf(leg, cutoffMs))
    .filter((leg): leg is CycleStockLeg => leg !== null)
    .map((leg) => (leg.exitAt !== null && leg.exitAt.getTime() > cutoffMs ? { ...leg, exitAt: null } : leg));
  const stockTrades = input.stockTrades.filter((trade) => trade.at.getTime() <= cutoffMs);
  const dailyCloses = new Map([...input.dailyCloses].filter(([date]) => date <= baselineDate));
  const closeOnBaseline = dailyCloses.get(baselineDate);

  // Option marks for every position that still has an open option leg at the baseline. A snapshot from before
  // 2026-09-09 has no premium/stock split; its total unrealized is the option-only figure only for a pure short-put
  // position that never held shares (calls can be covered, and reassigned stock legs left stock P&L on call-only
  // positions — AAOI/AMAT/SPCX on 2026-09-09..11). Anything else is marked unavailable and its cycle flagged.
  const openPositionPremiumPnl = new Map<string, number>();
  const openPositionPremiumPnlUnavailable = new Set<string>();
  const positionIds = new Set(optionLegs.filter((leg) => leg.exitAt === null).map((leg) => leg.positionId));
  for (const positionId of positionIds) {
    const marks = snapshotMarks.get(positionId);
    const legsOfPosition = optionLegs.filter((leg) => leg.positionId === positionId);
    const purePutsWithoutShares = legsOfPosition.every((leg) => leg.optionType === "put") && !stockLegs.some((leg) => leg.positionId === positionId);
    if (!marks) openPositionPremiumPnlUnavailable.add(positionId);
    else if (marks.premiumPnl !== null) openPositionPremiumPnl.set(positionId, marks.premiumPnl);
    else if (purePutsWithoutShares) openPositionPremiumPnl.set(positionId, marks.unrealizedPnl);
    else openPositionPremiumPnlUnavailable.add(positionId);
  }
  return {
    optionLegs,
    stockLegs,
    stockTrades,
    dailyCloses,
    lastPrice: closeOnBaseline === undefined ? null : { date: baselineDate, price: closeOnBaseline },
    openPositionPremiumPnl,
    openPositionPremiumPnlUnavailable,
  };
}

const bucketKeys: CycleBucket[] = ["csp", "unstructured", "cc", "hedge", "leaps"];

export function openMarkTotal(cycle: Cycle | undefined, bucket: CycleBucket): number {
  if (!cycle) return 0;
  // Open-leg marks, plus the cost of a hedge option still held (a bought option's price is not a realized loss).
  return cycle.timeline.filter((row) => (row.at === null || row.unrealized === true) && row.bucket === bucket).reduce((sum, row) => sum + row.premium + row.stock, 0);
}

export async function computeCyclePeriodPnl(): Promise<CyclePeriodPnl> {
  const emptyBucket = (): BucketPeriodPnl => ({ day: 0, week: 0, month: 0, year: 0, realizedYear: 0, unrealizedYear: 0 });
  const result: CyclePeriodPnl = {
    buckets: { csp: emptyBucket(), unstructured: emptyBucket(), cc: emptyBucket(), hedge: emptyBucket(), leaps: emptyBucket() },
    excludedByPeriod: { day: [], week: [], month: [], year: [] },
  };
  const baselineDates = await loadBaselineDates();
  if (baselineDates === null) return result;

  const [symbolInputs, snapshotMarksByPeriod] = await Promise.all([
    loadCycleInputsForTickers("all"),
    Promise.all(cyclePeriods.map((period) => loadSnapshotMarksOn(baselineDates[period]))),
  ]);

  for (const { symbol, input } of symbolInputs) {
    const cyclesNow = deriveCycles(input);
    cyclePeriods.forEach((period, periodIndex) => {
      const baselineInput = truncateCycleInputAsOf(input, baselineDates[period], snapshotMarksByPeriod[periodIndex]!);
      const cyclesAtBaseline = new Map(deriveCycles(baselineInput).map((cycle) => [cycle.startAt.getTime(), cycle]));
      const cutoffMs = easternInstant(baselineDates[period], 23, 59).getTime() + 59_999;
      for (const cycleNow of cyclesNow) {
        if (cycleNow.endAt !== null && cycleNow.endAt.getTime() <= cutoffMs) continue; // finished before the period: contributes nothing
        const cycleAtBaseline = cyclesAtBaseline.get(cycleNow.startAt.getTime());
        const flag = cycleNow.dataFlags[0] ?? cycleAtBaseline?.dataFlags[0];
        if (flag !== undefined) {
          result.excludedByPeriod[period].push({ symbol, reason: flag });
          continue;
        }
        for (const bucket of bucketKeys) {
          const periodPnl = cycleNow.buckets[bucket].total - (cycleAtBaseline?.buckets[bucket].total ?? 0);
          result.buckets[bucket][period] += periodPnl;
          if (period === "year") {
            const unrealized = openMarkTotal(cycleNow, bucket) - openMarkTotal(cycleAtBaseline, bucket);
            result.buckets[bucket].unrealizedYear += unrealized;
            result.buckets[bucket].realizedYear += periodPnl - unrealized;
          }
        }
      }
    });
  }
  return result;
}
