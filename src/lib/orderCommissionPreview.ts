import { OrderAction } from "@stoqey/ib";
import type { OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import type { CommissionEstimator, StockCommissionEstimator } from "./commissionEstimate.js";

// What the order setup shows about an order's commission (approved 2026-10-02): IBKR's what-if when it
// answers, otherwise the trailing-fills estimate labelled as such (option and stock legs, 2026-11-13), next to the order's net premium and the
// share of it the commission takes. IBKR's what-if returns a range (minCommission..maxCommission) for
// options, not one figure; the maximum drives the net premium and the warning (Marcelo's choice, 2026-10-02:
// worst case), the range stays visible.

export type CommissionPreviewSource = "ibkr_what_if" | "estimate";

export interface OrderCommissionPreview {
  /** The figure the net premium and the warning use: IBKR's maximum for the order, or the estimate. */
  commissionDollars: number;
  /** IBKR's minimum for the order; null for an estimate. */
  commissionMinDollars: number | null;
  source: CommissionPreviewSource;
  /** Why the exact figure is missing, when source is "estimate". */
  estimateReason: string | null;
  /** Premium received minus premium paid across the option legs, in dollars (negative for a net debit). */
  netPremiumDollars: number;
  /** Commission as a percentage of the net premium's size; null when the net premium is zero. */
  commissionSharePctOfPremium: number | null;
  warnThresholdPct: number;
  warn: boolean;
  /** Net premium minus commission, in dollars. */
  netCreditAfterCommissionDollars: number;
}

/** IBKR reports "not available" as Double.MAX_VALUE. */
const ibkrUnsetDouble = 1.7976931348623157e308;

export interface WhatIfCommissionRange {
  minDollars: number;
  maxDollars: number;
}

function readUsableCommission(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value >= ibkrUnsetDouble || value <= 0) return null;
  return value;
}

/**
 * Pure: the commission range in one of IBKR's what-if order states, or null when it carries none. IBKR sends two
 * states per what-if: a first with a placeholder commission of 0, then the real one with minCommission and
 * maxCommission (commission itself unset). A single usable commission counts as a range of one value.
 */
export function readWhatIfCommissionRange(orderState: { commission?: number; minCommission?: number; maxCommission?: number }): WhatIfCommissionRange | null {
  const single = readUsableCommission(orderState.commission);
  const min = readUsableCommission(orderState.minCommission) ?? single;
  const max = readUsableCommission(orderState.maxCommission) ?? single;
  if (min === null || max === null) return null;
  return { minDollars: Math.min(min, max), maxDollars: Math.max(min, max) };
}

/** Pure: each option leg at the per-contract estimate for its side and size, each stock leg at the per-share estimate for its side. */
export function estimateLegsCommissionDollars(legs: OrderLegPayload[], estimator: CommissionEstimator, stockEstimator: StockCommissionEstimator): number {
  return legs.reduce((sum, leg) => {
    const side = leg.action === OrderAction.BUY ? "buy" : "sell";
    return sum + (leg.role === "option" ? estimator.perContractDollars(side, leg.quantity) : stockEstimator.perShareDollars(side)) * leg.quantity;
  }, 0);
}

/** Pure: premium received minus premium paid across the option legs, in dollars. */
export function computeNetOptionPremiumDollars(legs: OrderLegPayload[]): number {
  return legs.filter((leg) => leg.role === "option").reduce((sum, leg) => sum + (leg.action === OrderAction.SELL ? 1 : -1) * leg.unitPrice * leg.quantity * 100, 0);
}

export function buildOrderCommissionPreview(input: {
  legs: OrderLegPayload[];
  whatIfCommission: WhatIfCommissionRange | null;
  /** Why the what-if gave nothing; recorded when the estimate is used. */
  whatIfFailureReason: string | null;
  estimator: CommissionEstimator;
  stockEstimator: StockCommissionEstimator;
  warnThresholdPct: number;
}): OrderCommissionPreview {
  const exact = input.whatIfCommission !== null;
  const commissionDollars = input.whatIfCommission?.maxDollars ?? estimateLegsCommissionDollars(input.legs, input.estimator, input.stockEstimator);
  const netPremiumDollars = computeNetOptionPremiumDollars(input.legs);
  const commissionSharePctOfPremium = netPremiumDollars === 0 ? null : (commissionDollars / Math.abs(netPremiumDollars)) * 100;
  // A net debit or a zero premium can never absorb the commission: warn whatever the threshold says.
  const warn = netPremiumDollars <= 0 ? true : commissionSharePctOfPremium! > input.warnThresholdPct;
  return {
    commissionDollars,
    commissionMinDollars: input.whatIfCommission?.minDollars ?? null,
    source: exact ? "ibkr_what_if" : "estimate",
    estimateReason: exact ? null : input.whatIfFailureReason,
    netPremiumDollars,
    commissionSharePctOfPremium,
    warnThresholdPct: input.warnThresholdPct,
    warn,
    netCreditAfterCommissionDollars: netPremiumDollars - commissionDollars,
  };
}
