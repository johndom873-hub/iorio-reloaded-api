import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import { computeCashLockedInCsps, computePositionExposures, type PositionExposureRow } from "./positionExposure.js";
import { fetchAvailableUncoveredShares } from "./positionQueries.js";
import type { SignalStrategyKey } from "./signalCandidates.js";
import { loadSignalSettings } from "./signalSettingsStore.js";

// Order-placement limits. Two callers share one evaluator (gap fix 6 for Pluto, 2026-09-28):
//
// - evaluateSignalOrderLimits: the three Signals-tab settings (approved 2026-09-24) for orders
//   that came from the Signals / Roll Signals flow (signal_snapshot set).
// - evaluateStrategyOrderLimits (strategyOrderLimits.ts): the Trade Alerts tab's
//   strategy_settings maxima — the same three plus max concentration per sector and max
//   aggregate CSP collateral — for every other opening order and roll. Those settings were
//   stored and edited but never enforced anywhere until 2026-09-28.
//
// Formulas all reuse the platform's existing valuation conventions -- total portfolio value is
// netLiquidationValue (same as riskLimits.ts's /exposure), existing per-ticker/sector exposure
// is computePositionExposures (same as the concentration figures there), and free cash is the
// same totalCashValue minus CSP collateral the Signals screen already uses.
//
// This order's own notional contribution: a cash-secured put reserves strike*100*quantity in
// cash; a covered call only adds notional for the shares it has to buy (the shortfall beyond
// what's already held uncovered), using the exact same shortfall math positions.ts's
// order-build auto-fill uses -- a fully-covered covered call therefore contributes 0.
//
// Fails closed: if account/portfolio data can't be verified, every check is reported as
// blocked rather than silently skipped (Marcelo approved 2026-09-24) -- this gates real
// order confirmations, unlike the informational-only exposure page.

export interface SignalOrderLimitsInput {
  strategyKey: SignalStrategyKey;
  symbol: string;
  tickerId: string;
  /** The ticker's sector, only needed for the per-sector check (strategy limits). */
  sector?: string | null;
  quantity: number;
  strike: number;
  /** Underlying stock price, used only for a covered call's share-shortfall notional. Omit to read the pool, then fetch a live price. */
  spotPrice?: number;
  /** Current per-position exposures when the caller already streams them (the Order Review quote stream); omit to compute them. */
  exposures?: PositionExposureRow[];
  /**
   * Roll Signals: the strike of the short leg this order closes. A roll re-uses the closed leg's notional, so
   * only the difference counts -- a covered-call roll adds nothing (the shares are already held), a
   * cash-secured-put roll adds (newStrike − oldStrike) × 100 × quantity when it moves up, never a negative.
   */
  rollFromStrike?: number;
}

export interface SignalOrderLimitsResult {
  blocked: boolean;
  reasons: string[];
}

/** The ceilings one evaluation checks against; undefined optional ceilings are simply not checked. */
export interface OrderLimitThresholds {
  /** Names the tab the numbers come from in every block message, e.g. "Signals tab". */
  sourceLabel: string;
  maxPositionPctOfPortfolio: number;
  maxConcentrationPerTickerPct: number;
  minCashReservePct: number;
  maxConcentrationPerSectorPct?: number;
  maxAggregateCollateralPct?: number;
}

/** The figures the pure threshold check needs, all in dollars. */
export interface OrderLimitFigures {
  symbol: string;
  sector: string | null;
  strategyKey: SignalStrategyKey;
  totalPortfolioValue: number;
  freeCash: number;
  orderNotional: number;
  existingTickerExposure: number;
  existingSectorExposure: number;
  cashLockedInCsps: number;
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

async function resolveSpotPrice(input: SignalOrderLimitsInput): Promise<number | null> {
  if (input.spotPrice !== undefined) return input.spotPrice;
  if (input.strategyKey !== "covered_call" || input.rollFromStrike !== undefined) return 0; // not needed for a cash-secured put or any roll
  const prices = await fetchPricesPoolFirst([{ key: "stock", legType: "stock", symbol: input.symbol }]);
  return prices["stock"] ?? null;
}

/** Pure: this order's own added notional -- see file header for the CSP/covered-call formulas and the roll rule. */
export function computeSignalOrderNotional(input: Pick<SignalOrderLimitsInput, "strategyKey" | "strike" | "quantity" | "rollFromStrike">, spotPrice: number, availableUncoveredShares: number): number {
  if (input.rollFromStrike !== undefined) {
    if (input.strategyKey === "covered_call") return 0;
    return Math.max(0, input.strike - input.rollFromStrike) * 100 * input.quantity;
  }
  if (input.strategyKey === "cash_secured_put") return input.strike * 100 * input.quantity;
  const shortfallShares = Math.max(0, input.quantity * 100 - availableUncoveredShares);
  return shortfallShares * spotPrice;
}

async function computeOrderNotional(input: SignalOrderLimitsInput, spotPrice: number): Promise<number> {
  const needsShares = input.strategyKey === "covered_call" && input.rollFromStrike === undefined;
  return computeSignalOrderNotional(input, spotPrice, needsShares ? await fetchAvailableUncoveredShares(input.tickerId) : 0);
}

/** Pure: every ceiling compared against the figures; one reason per breach, in the order the settings page lists them. */
export function applyOrderLimitThresholds(figures: OrderLimitFigures, thresholds: OrderLimitThresholds): SignalOrderLimitsResult {
  const { totalPortfolioValue, orderNotional } = figures;
  const reasons: string[] = [];
  const source = thresholds.sourceLabel;

  const positionSharePct = orderNotional / totalPortfolioValue;
  if (positionSharePct * 100 > thresholds.maxPositionPctOfPortfolio) {
    reasons.push(`This order is ${formatPct(positionSharePct)} of portfolio value, above the ${source}'s ${thresholds.maxPositionPctOfPortfolio}% max position size.`);
  }

  if (thresholds.maxAggregateCollateralPct !== undefined && figures.strategyKey === "cash_secured_put") {
    const collateralAfterPct = (figures.cashLockedInCsps + orderNotional) / totalPortfolioValue;
    if (collateralAfterPct * 100 > thresholds.maxAggregateCollateralPct) {
      reasons.push(`Cash-secured-put collateral would be ${formatPct(collateralAfterPct)} of portfolio value, above the ${source}'s ${thresholds.maxAggregateCollateralPct}% max aggregate collateral.`);
    }
  }

  const concentrationAfterPct = (figures.existingTickerExposure + orderNotional) / totalPortfolioValue;
  if (concentrationAfterPct * 100 > thresholds.maxConcentrationPerTickerPct) {
    reasons.push(`${figures.symbol} would be ${formatPct(concentrationAfterPct)} of portfolio value, above the ${source}'s ${thresholds.maxConcentrationPerTickerPct}% max concentration per ticker.`);
  }

  if (thresholds.maxConcentrationPerSectorPct !== undefined) {
    const sectorAfterPct = (figures.existingSectorExposure + orderNotional) / totalPortfolioValue;
    if (sectorAfterPct * 100 > thresholds.maxConcentrationPerSectorPct) {
      reasons.push(`The ${figures.sector ?? "unknown"} sector would be ${formatPct(sectorAfterPct)} of portfolio value, above the ${source}'s ${thresholds.maxConcentrationPerSectorPct}% max concentration per sector.`);
    }
  }

  const cashReserveAfterPct = (figures.freeCash - orderNotional) / totalPortfolioValue;
  if (cashReserveAfterPct * 100 < thresholds.minCashReservePct) {
    reasons.push(`Placing this order would leave only ${formatPct(cashReserveAfterPct)} of portfolio value as cash, below the ${source}'s ${thresholds.minCashReservePct}% min cash reserve.`);
  }

  return { blocked: reasons.length > 0, reasons };
}

/** Loads live account/exposure figures and applies the given ceilings. Fails closed on any unverifiable input. */
export async function evaluateOrderLimits(input: SignalOrderLimitsInput, loadThresholds: () => Promise<OrderLimitThresholds>): Promise<SignalOrderLimitsResult> {
  let account: Awaited<ReturnType<typeof fetchAccountSummary>>;
  let cashLockedInCsps: number;
  let exposures: Awaited<ReturnType<typeof computePositionExposures>>;
  let thresholds: OrderLimitThresholds;
  let spotPrice: number | null;
  try {
    [account, cashLockedInCsps, exposures, thresholds, spotPrice] = await Promise.all([
      fetchAccountSummary(),
      computeCashLockedInCsps(),
      input.exposures ?? computePositionExposures(),
      loadThresholds(),
      resolveSpotPrice(input),
    ]);
  } catch (error) {
    return { blocked: true, reasons: [`Could not verify position limits: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (spotPrice === null) {
    return { blocked: true, reasons: ["Could not fetch a live stock price to verify position limits."] };
  }

  const totalPortfolioValue = account.netLiquidationValue;
  if (totalPortfolioValue === null || !(totalPortfolioValue > 0)) {
    return { blocked: true, reasons: ["Could not verify position limits: total portfolio value is unavailable."] };
  }

  const freeCash = Math.max(0, (account.totalCashValue ?? 0) - cashLockedInCsps);
  const orderNotional = await computeOrderNotional(input, spotPrice);
  const sector = input.sector ?? null;

  return applyOrderLimitThresholds(
    {
      symbol: input.symbol,
      sector,
      strategyKey: input.strategyKey,
      totalPortfolioValue,
      freeCash,
      orderNotional,
      existingTickerExposure: exposures.filter((row) => row.symbol === input.symbol).reduce((sum, row) => sum + row.exposure, 0),
      existingSectorExposure: sector === null ? 0 : exposures.filter((row) => row.sector === sector).reduce((sum, row) => sum + row.exposure, 0),
      cashLockedInCsps,
    },
    thresholds,
  );
}

export async function evaluateSignalOrderLimits(input: SignalOrderLimitsInput): Promise<SignalOrderLimitsResult> {
  return evaluateOrderLimits(input, async () => {
    const settings = await loadSignalSettings();
    return {
      sourceLabel: "Signals tab",
      maxPositionPctOfPortfolio: settings.maxPositionPctOfPortfolio,
      maxConcentrationPerTickerPct: settings.maxConcentrationPerTickerPct,
      minCashReservePct: settings.minCashReservePct,
    };
  });
}
