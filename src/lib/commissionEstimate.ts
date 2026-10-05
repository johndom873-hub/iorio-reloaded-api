import { db } from "../db/connection.js";
import { commissionPerContractDollars as flatCommissionPerContractDollars } from "./optionFriction.js";

// Commission estimate for scoring (approved 2026-10-02): the mean commission per contract over the
// last N filled option orders of the same side and size bucket, read from `trades.commission`
// (IBKR's own commission reports). A bucket with fewer than M orders falls back to the flat
// $0.68 per contract, so scoring never stops while fills are thin. The exact commission for one
// order comes from IBKR's what-if at order setup (ibkrWhatIfCommission.ts); this is only the
// estimate for the Signals list, where no order exists yet.

export const commissionTrailingOrderCount = 50;
export const commissionMinimumOrdersPerBucket = 10;
const commissionEstimatorCacheMs = 10 * 60_000;
// Far more than 6 groups x N, so the newest N of every group are always inside the window.
const filledOrdersLoadWindow = 1_000;

export type OptionOrderSide = "buy" | "sell";
export type ContractCountBucket = "1" | "2-4" | "5+";

export function contractCountBucket(contracts: number): ContractCountBucket {
  if (contracts <= 1) return "1";
  if (contracts <= 4) return "2-4";
  return "5+";
}

export interface FilledOptionOrderCommission {
  side: OptionOrderSide;
  contracts: number;
  commissionDollars: number;
}

export interface CommissionEstimator {
  /** Estimated commission in dollars per contract for an order of `contracts` contracts. */
  perContractDollars(side: OptionOrderSide, contracts: number): number;
}

/** Always the flat per-contract rate: the default wherever no fills have been loaded (tests, scripts). */
export const flatCommissionEstimator: CommissionEstimator = {
  perContractDollars: () => flatCommissionPerContractDollars,
};

/** Pure: `ordersNewestFirst` must be sorted newest first. */
export function buildCommissionEstimator(ordersNewestFirst: FilledOptionOrderCommission[]): CommissionEstimator {
  const perContractRatiosByGroup = new Map<string, number[]>();
  for (const order of ordersNewestFirst) {
    if (!(order.contracts > 0) || !(order.commissionDollars > 0)) continue;
    const groupKey = `${order.side}|${contractCountBucket(order.contracts)}`;
    const ratios = perContractRatiosByGroup.get(groupKey) ?? [];
    if (ratios.length < commissionTrailingOrderCount) ratios.push(order.commissionDollars / order.contracts);
    perContractRatiosByGroup.set(groupKey, ratios);
  }
  return {
    perContractDollars(side, contracts) {
      const ratios = perContractRatiosByGroup.get(`${side}|${contractCountBucket(contracts)}`);
      if (!ratios || ratios.length < commissionMinimumOrdersPerBucket) return flatCommissionPerContractDollars;
      return ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
    },
  };
}

/** Option orders whose every fill has a commission report, newest first, one row per IBKR order and side. */
async function loadFilledOptionOrderCommissions(): Promise<FilledOptionOrderCommission[]> {
  const rows = await db("trades as t")
    .join("position_legs as l", "l.id", "t.position_leg_id")
    .where("l.leg_type", "option")
    .whereNotNull("t.ibkr_order_id")
    .groupBy("t.ibkr_order_id", "t.side")
    .havingRaw("count(t.commission) = count(*)")
    .orderByRaw("max(t.executed_at) desc")
    .limit(filledOrdersLoadWindow)
    .select("t.side as side", db.raw("sum(t.quantity)::int as contracts"), db.raw("sum(t.commission) as commission_dollars"));
  return rows.map((row) => ({ side: row.side as OptionOrderSide, contracts: Number(row.contracts), commissionDollars: Number(row.commission_dollars) }));
}

let cachedEstimator: { estimator: CommissionEstimator; loadedAtMs: number } | null = null;
let inFlightLoad: Promise<CommissionEstimator> | null = null;

/** Cached for 10 minutes; a database failure scores with the flat rate rather than failing the scoring pass. */
export async function loadCommissionEstimator(): Promise<CommissionEstimator> {
  if (cachedEstimator && Date.now() - cachedEstimator.loadedAtMs < commissionEstimatorCacheMs) return cachedEstimator.estimator;
  inFlightLoad ??= loadFilledOptionOrderCommissions()
    .then((orders) => {
      const estimator = buildCommissionEstimator(orders);
      cachedEstimator = { estimator, loadedAtMs: Date.now() };
      return estimator;
    })
    .catch((error) => {
      console.error(`Commission estimator: could not load fills, using the flat rate: ${error instanceof Error ? error.message : error}`);
      return cachedEstimator?.estimator ?? flatCommissionEstimator;
    })
    .finally(() => {
      inFlightLoad = null;
    });
  return inFlightLoad;
}
