import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { fetchLivePrices } from "../ibkr/fetchLivePrices.js";
import { computeCashLockedInCsps, computePositionExposures } from "./positionExposure.js";
import { fetchAvailableUncoveredShares } from "./positionQueries.js";
import type { SignalStrategyKey } from "./signalCandidates.js";
import { loadSignalSettings } from "./signalSettingsStore.js";

// The three Signals-tab settings that block *placing* an order (as opposed
// to maxNetDelta/minAnnualizedYieldPct/maxDeltaDriftPct, which filter which
// opportunities are generated in the first place -- see signalCandidates.ts
// and signalsLiveScoring.ts). Approved 2026-09-24. Formulas all reuse the
// platform's existing valuation conventions -- total portfolio value is
// netLiquidationValue (same as riskLimits.ts's /exposure), existing per-
// ticker exposure is computePositionExposures (same as the concentration-
// by-ticker figure there), and free cash is the same totalCashValue minus
// CSP collateral the Signals screen already uses.
//
// This order's own notional contribution: a cash-secured put reserves
// strike*100*quantity in cash; a covered call only adds notional for the
// shares it has to buy (the shortfall beyond what's already held
// uncovered), using the exact same shortfall math positions.ts's order-build
// auto-fill uses -- a fully-covered covered call therefore contributes 0.
//
// Fails closed: if account/portfolio data can't be verified, every check is
// reported as blocked rather than silently skipped (Marcelo approved
// 2026-09-24) -- this function gates real order confirmations, unlike the
// informational-only exposure page.

export interface SignalOrderLimitsInput {
  strategyKey: SignalStrategyKey;
  symbol: string;
  tickerId: string;
  quantity: number;
  strike: number;
  /** Underlying stock price, used only for a covered call's share-shortfall notional. Omit to fetch a live price. */
  spotPrice?: number;
}

export interface SignalOrderLimitsResult {
  blocked: boolean;
  reasons: string[];
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

async function resolveSpotPrice(input: SignalOrderLimitsInput): Promise<number | null> {
  if (input.spotPrice !== undefined) return input.spotPrice;
  if (input.strategyKey !== "covered_call") return 0; // not needed for a cash-secured put
  const prices = await fetchLivePrices([{ key: "stock", legType: "stock", symbol: input.symbol }]);
  return prices["stock"] ?? null;
}

/** This order's own added notional -- see file header for the CSP/covered-call formulas. */
async function computeOrderNotional(input: SignalOrderLimitsInput, spotPrice: number): Promise<number> {
  if (input.strategyKey === "cash_secured_put") return input.strike * 100 * input.quantity;
  const availableUncoveredShares = await fetchAvailableUncoveredShares(input.tickerId);
  const shortfallShares = Math.max(0, input.quantity * 100 - availableUncoveredShares);
  return shortfallShares * spotPrice;
}

export async function evaluateSignalOrderLimits(input: SignalOrderLimitsInput): Promise<SignalOrderLimitsResult> {
  let account: Awaited<ReturnType<typeof fetchAccountSummary>>;
  let cashLockedInCsps: number;
  let exposures: Awaited<ReturnType<typeof computePositionExposures>>;
  let settings: Awaited<ReturnType<typeof loadSignalSettings>>;
  let spotPrice: number | null;
  try {
    [account, cashLockedInCsps, exposures, settings, spotPrice] = await Promise.all([
      fetchAccountSummary(),
      computeCashLockedInCsps(),
      computePositionExposures(),
      loadSignalSettings(),
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

  const reasons: string[] = [];

  const positionSharePct = orderNotional / totalPortfolioValue;
  if (positionSharePct * 100 > settings.maxPositionPctOfPortfolio) {
    reasons.push(`This order is ${formatPct(positionSharePct)} of portfolio value, above the ${settings.maxPositionPctOfPortfolio}% max position size.`);
  }

  const existingTickerExposure = exposures.filter((row) => row.symbol === input.symbol).reduce((sum, row) => sum + row.exposure, 0);
  const concentrationAfterPct = (existingTickerExposure + orderNotional) / totalPortfolioValue;
  if (concentrationAfterPct * 100 > settings.maxConcentrationPerTickerPct) {
    reasons.push(`${input.symbol} would be ${formatPct(concentrationAfterPct)} of portfolio value, above the ${settings.maxConcentrationPerTickerPct}% max concentration per ticker.`);
  }

  const cashReserveAfterPct = (freeCash - orderNotional) / totalPortfolioValue;
  if (cashReserveAfterPct * 100 < settings.minCashReservePct) {
    reasons.push(`Placing this order would leave only ${formatPct(cashReserveAfterPct)} of portfolio value as cash, below the ${settings.minCashReservePct}% min cash reserve.`);
  }

  return { blocked: reasons.length > 0, reasons };
}
