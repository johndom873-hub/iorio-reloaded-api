import { db } from "../db/connection.js";
import { deriveCycles, type Cycle, type CycleBucket, type CycleInput } from "./cycles.js";
import { loadCycleInputsForTickers } from "./cycleQueries.js";
import { easternInstant } from "./marketSessionStatus.js";

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
//   Week/Month/Year = the last trading day before this Monday / the 1st / Jan 1 (by CURRENT_DATE, as the account card does)

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

interface SnapshotMarks {
  premiumPnl: number | null;
  unrealizedPnl: number;
}

const previousTradingDaySql = (boundary: string) => `COALESCE(
  (SELECT MAX(calendar_date) FROM market_calendar WHERE calendar_date < ${boundary} AND is_open = true),
  (${boundary} - (CASE EXTRACT(ISODOW FROM ${boundary}) WHEN 1 THEN 3 WHEN 7 THEN 2 ELSE 1 END)::int)
)::text`;

async function loadBaselineDates(): Promise<Record<CyclePeriod, string> | null> {
  const result = await db.raw(`
    SELECT
      CASE WHEN latest.d IS NULL THEN NULL ELSE ${previousTradingDaySql("latest.d")} END AS day,
      ${previousTradingDaySql("date_trunc('week', CURRENT_DATE)::date")} AS week,
      ${previousTradingDaySql("date_trunc('month', CURRENT_DATE)::date")} AS month,
      ${previousTradingDaySql("date_trunc('year', CURRENT_DATE)::date")} AS year
    FROM (SELECT MAX(snapshot_date) AS d FROM account_pnl_snapshots) latest
  `);
  const row = result.rows[0];
  if (!row || row.day === null) return null;
  return { day: row.day, week: row.week, month: row.month, year: row.year };
}

async function loadSnapshotMarksOn(dateIso: string): Promise<Map<string, SnapshotMarks>> {
  const result = await db.raw(
    `SELECT position_id AS "positionId", premium_pnl::float AS "premiumPnl", unrealized_pnl::float AS "unrealizedPnl"
     FROM position_pnl_snapshots WHERE snapshot_date = ?`,
    [dateIso],
  );
  return new Map(result.rows.map((row: { positionId: string; premiumPnl: number | null; unrealizedPnl: number }) => [row.positionId, { premiumPnl: row.premiumPnl, unrealizedPnl: row.unrealizedPnl }]));
}

/** The ledger as it stood at the end of baselineDate (Eastern). Exported for tests. */
export function truncateCycleInputAsOf(input: CycleInput, baselineDate: string, snapshotMarks: Map<string, SnapshotMarks>): CycleInput {
  const cutoffMs = easternInstant(baselineDate, 23, 59).getTime() + 59_999;
  const optionLegs = input.optionLegs
    .filter((leg) => leg.entryAt.getTime() <= cutoffMs)
    .map((leg) => (leg.exitAt !== null && leg.exitAt.getTime() > cutoffMs ? { ...leg, exitAt: null, exitPrice: null, closingCommission: 0, hasClosingTrade: false } : leg));
  const stockLegs = input.stockLegs
    .filter((leg) => leg.entryAt.getTime() <= cutoffMs)
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

const bucketKeys: CycleBucket[] = ["csp", "unstructured", "cc"];

function openMarkTotal(cycle: Cycle | undefined, bucket: CycleBucket): number {
  if (!cycle) return 0;
  return cycle.timeline.filter((row) => row.at === null && row.bucket === bucket).reduce((sum, row) => sum + row.premium + row.stock, 0);
}

export async function computeCyclePeriodPnl(): Promise<CyclePeriodPnl> {
  const emptyBucket = (): BucketPeriodPnl => ({ day: 0, week: 0, month: 0, year: 0, realizedYear: 0, unrealizedYear: 0 });
  const result: CyclePeriodPnl = {
    buckets: { csp: emptyBucket(), unstructured: emptyBucket(), cc: emptyBucket() },
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
