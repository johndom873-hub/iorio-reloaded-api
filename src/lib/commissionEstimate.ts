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
export type StockOrderSide = "buy" | "sell";
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

/** Orders of one leg type whose every fill has a commission report, newest first, one row per IBKR order and side. */
async function loadFilledOrderCommissions(legType: "option" | "stock"): Promise<Array<{ side: "buy" | "sell"; quantity: number; commissionDollars: number }>> {
  const rows = await db("trades as t")
    .join("position_legs as l", "l.id", "t.position_leg_id")
    .where("l.leg_type", legType)
    .whereNotNull("t.ibkr_order_id")
    .groupBy("t.ibkr_order_id", "t.side")
    .havingRaw("count(t.commission) = count(*)")
    .orderByRaw("max(t.executed_at) desc")
    .limit(filledOrdersLoadWindow)
    .select("t.side as side", db.raw("sum(t.quantity)::int as quantity"), db.raw("sum(t.commission) as commission_dollars"));
  return rows.map((row) => ({ side: row.side as "buy" | "sell", quantity: Number(row.quantity), commissionDollars: Number(row.commission_dollars) }));
}

/** Cached for 10 minutes; a database failure falls back to the last good estimator, else the flat one, rather than failing the caller. */
function createCachedEstimatorLoader<Estimator>(label: string, loadEstimator: () => Promise<Estimator>, flatEstimator: Estimator): () => Promise<Estimator> {
  let cachedEstimator: { estimator: Estimator; loadedAtMs: number } | null = null;
  let inFlightLoad: Promise<Estimator> | null = null;
  return () => {
    if (cachedEstimator && Date.now() - cachedEstimator.loadedAtMs < commissionEstimatorCacheMs) return Promise.resolve(cachedEstimator.estimator);
    inFlightLoad ??= loadEstimator()
      .then((estimator) => {
        cachedEstimator = { estimator, loadedAtMs: Date.now() };
        return estimator;
      })
      .catch((error) => {
        console.error(`${label}: could not load fills, using the flat rate: ${error instanceof Error ? error.message : error}`);
        return cachedEstimator?.estimator ?? flatEstimator;
      })
      .finally(() => {
        inFlightLoad = null;
      });
    return inFlightLoad;
  };
}

export const loadCommissionEstimator = createCachedEstimatorLoader(
  "Commission estimator",
  async () => buildCommissionEstimator((await loadFilledOrderCommissions("option")).map((order) => ({ side: order.side, contracts: order.quantity, commissionDollars: order.commissionDollars }))),
  flatCommissionEstimator,
);

// Stock counterpart (approved 2026-10-09, for the Close form's cycle P&L estimate): the mean commission per share
// over the last N filled stock orders of the same side, N and M as for options. No size buckets -- stock commission
// grows roughly in line with shares. A side with fewer than M orders falls back to the flat $0.005 per share.
export const flatStockCommissionPerShareDollars = 0.005;

export interface FilledStockOrderCommission {
  side: StockOrderSide;
  shares: number;
  commissionDollars: number;
}

export interface StockCommissionEstimator {
  /** Estimated commission in dollars per share for a stock order on `side`. */
  perShareDollars(side: StockOrderSide): number;
}

export const flatStockCommissionEstimator: StockCommissionEstimator = {
  perShareDollars: () => flatStockCommissionPerShareDollars,
};

/** Pure: `ordersNewestFirst` must be sorted newest first. */
export function buildStockCommissionEstimator(ordersNewestFirst: FilledStockOrderCommission[]): StockCommissionEstimator {
  const perShareRatiosBySide = new Map<StockOrderSide, number[]>();
  for (const order of ordersNewestFirst) {
    if (!(order.shares > 0) || !(order.commissionDollars > 0)) continue;
    const ratios = perShareRatiosBySide.get(order.side) ?? [];
    if (ratios.length < commissionTrailingOrderCount) ratios.push(order.commissionDollars / order.shares);
    perShareRatiosBySide.set(order.side, ratios);
  }
  return {
    perShareDollars(side) {
      const ratios = perShareRatiosBySide.get(side);
      if (!ratios || ratios.length < commissionMinimumOrdersPerBucket) return flatStockCommissionPerShareDollars;
      return ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
    },
  };
}

export const loadStockCommissionEstimator = createCachedEstimatorLoader(
  "Stock commission estimator",
  async () => buildStockCommissionEstimator((await loadFilledOrderCommissions("stock")).map((order) => ({ side: order.side, shares: order.quantity, commissionDollars: order.commissionDollars }))),
  flatStockCommissionEstimator,
);

/** Every rate the Close form needs to estimate a close's commission client-side, sent once per stream state. */
export interface CloseCommissionRates {
  optionPerContractDollars: Record<OptionOrderSide, Record<ContractCountBucket, number>>;
  stockPerShareDollars: Record<StockOrderSide, number>;
}

const representativeContractsByBucket: Record<ContractCountBucket, number> = { "1": 1, "2-4": 2, "5+": 5 };

export function closeCommissionRates(optionEstimator: CommissionEstimator, stockEstimator: StockCommissionEstimator): CloseCommissionRates {
  const optionRatesFor = (side: OptionOrderSide) =>
    Object.fromEntries(Object.entries(representativeContractsByBucket).map(([bucket, contracts]) => [bucket, optionEstimator.perContractDollars(side, contracts)])) as Record<ContractCountBucket, number>;
  return {
    optionPerContractDollars: { buy: optionRatesFor("buy"), sell: optionRatesFor("sell") },
    stockPerShareDollars: { buy: stockEstimator.perShareDollars("buy"), sell: stockEstimator.perShareDollars("sell") },
  };
}
