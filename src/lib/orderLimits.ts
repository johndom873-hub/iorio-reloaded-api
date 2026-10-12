import { db } from "../db/connection.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import { computeCashLockedInCsps, computeTickerExposure } from "./positionExposure.js";
import { fetchAvailableUncoveredShares } from "./positionQueries.js";
import { loadTradingSettings, type TradingSettings } from "./tradingSettingsStore.js";
import { orderFillsPendingSql } from "./orderFills.js";
import { formatWholeDollars } from "./formatWholeDollars.js";

// The three trading settings that block *placing* an order: max position %, max concentration per ticker %
// and min cash reserve % (table trading_settings, edited on Risk & Limits). They apply to EVERY opening or
// rolling order whatever its origin (Signals, the position form, Genosuke); a close only reduces exposure and is
// not limit-checked (approved 2026-10-05). Formulas all reuse the platform's existing valuation conventions --
// total portfolio value is netLiquidationValue (same as riskLimits.ts's /exposure), existing per-ticker
// exposure is computePositionExposures (same as the concentration-by-ticker figure there), and free cash is
// totalCashValue minus CSP collateral.
//
// This order's own notional contribution, net of the premium it sells for (Marcelo 2026-10-12, the same exposure
// as Positions' EXP $): a cash-secured put reserves (strike − premium) × 100 × quantity, since the premium lands in
// cash as the strike is reserved; a covered call only adds notional for the shares it has to buy (the shortfall
// beyond what's already held uncovered, the same shortfall math positions.ts's order-build auto-fill uses), less
// the premium on those shares -- a fully-covered covered call therefore contributes 0. Free cash is IBKR's cash
// balance (which already holds every premium received) less the full strike of each open put, so cash after a
// fill is exactly free cash less this net notional.
//
// Orders still on their way to or working at IBKR (confirmed, submitted, partially filled, cancel requested) are
// counted too (approved 2026-10-05): their notional is added to the ticker's exposure and subtracted from free
// cash, so two orders confirmed seconds apart cannot both pass a limit only one fits under. A partly filled order
// is counted in full, so its filled part is briefly counted twice: the check errs towards blocking.
//
// Fails closed: if account/portfolio data can't be verified, every check is reported as blocked rather than
// silently skipped (Marcelo approved 2026-09-24) -- this function gates real order confirmations.

export type OrderLimitsStrategyKey = "covered_call" | "cash_secured_put";

export interface OrderLimitsInput {
  strategyKey: OrderLimitsStrategyKey;
  symbol: string;
  tickerId: string;
  quantity: number;
  strike: number;
  /** Price per share the option is sold at (the limit, or the mid for a preview): the order's notional is net of it. */
  premium: number;
  /** Underlying stock price, used only for a covered call's share-shortfall notional. Omit to read the pool, then fetch a live price. */
  spotPrice?: number;
  /**
   * Roll: the strike of the short leg this order closes. A roll re-uses the closed leg's notional, so
   * only the difference counts -- a covered-call roll adds nothing (the shares are already held), a
   * cash-secured-put roll adds (newStrike − oldStrike − net credit) × 100 × quantity, never a negative.
   */
  rollFromStrike?: number;
  /** Roll: the price per share paid to buy the closed leg back; the roll's net credit is premium − rollFromPremium. Required with rollFromStrike. */
  rollFromPremium?: number;
  /** The order being evaluated, left out of the in-flight totals (it is not in flight against itself). */
  excludeOrderRequestId?: string;
}

export interface OrderLimitsDetails {
  orderNotional: number;
  totalPortfolioValue: number;
  positionSharePct: number;
  concentrationAfterPct: number;
  cashReserveAfterPct: number;
  inFlightNotional: number;
  limits: { maxPositionPctOfPortfolio: number; maxConcentrationPerTickerPct: number; minCashReservePct: number };
}

export interface OrderLimitsResult {
  blocked: boolean;
  reasons: string[];
  /** Absent when the limits could not be verified (the result is then a block with its reason). */
  details?: OrderLimitsDetails;
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

async function resolveSpotPrice(input: OrderLimitsInput): Promise<number | null> {
  if (input.spotPrice !== undefined) return input.spotPrice;
  if (input.strategyKey !== "covered_call" || input.rollFromStrike !== undefined) return 0; // not needed for a cash-secured put or any roll
  const prices = await fetchPricesPoolFirst([{ key: "stock", legType: "stock", symbol: input.symbol }]);
  return prices["stock"] ?? null;
}

/** A put roll's added notional per share: the strike difference less the roll's net credit, never a negative. */
function putRollNotionalPerShare(newStrike: number, oldStrike: number, newPremium: number, buybackPrice: number): number {
  return Math.max(0, newStrike - oldStrike - (newPremium - buybackPrice));
}

/** Pure: this order's own added notional -- see file header for the CSP/covered-call formulas and the roll rule. */
export function computeOrderNotional(input: Pick<OrderLimitsInput, "strategyKey" | "strike" | "quantity" | "premium" | "rollFromStrike" | "rollFromPremium">, spotPrice: number, availableUncoveredShares: number): number {
  if (input.rollFromStrike !== undefined) {
    if (input.strategyKey === "covered_call") return 0;
    if (input.rollFromPremium === undefined) throw new Error("A roll's limit check needs the closed leg's buyback price (rollFromPremium).");
    return putRollNotionalPerShare(input.strike, input.rollFromStrike, input.premium, input.rollFromPremium) * 100 * input.quantity;
  }
  if (input.strategyKey === "cash_secured_put") return Math.max(0, input.strike - input.premium) * 100 * input.quantity;
  const shortfallShares = Math.max(0, input.quantity * 100 - availableUncoveredShares);
  return shortfallShares * Math.max(0, spotPrice - input.premium);
}

/**
 * Pure: the notional an order already on its way to IBKR still ties up, read from its stored payload (no market data needed), net of
 * the premium at its limit prices: a put open reserves (strike − premium) × 100 × contracts, a covered-call open costs its buy-write
 * stock leg less the call's premium on those shares (nothing when it is written against shares already held), a put roll adds the
 * strike difference less its net credit when that is positive, a call roll and every close add nothing.
 */
export function computeInFlightOrderNotional(requestType: string, payload: OrderRequestPayload): number {
  const strategyKey = payload.strategyKey;
  if (strategyKey !== "covered_call" && strategyKey !== "cash_secured_put") return 0;
  if (requestType === "roll_leg") {
    if (strategyKey === "covered_call") return 0;
    const openLeg = payload.legs.find((leg) => leg.role === "option" && !leg.positionLegId);
    const closeLeg = payload.legs.find((leg) => leg.role === "option" && leg.positionLegId);
    if (!openLeg?.strike || !closeLeg?.strike) return 0;
    return putRollNotionalPerShare(openLeg.strike, closeLeg.strike, openLeg.unitPrice, closeLeg.unitPrice) * 100 * openLeg.quantity;
  }
  if (!requestType.startsWith("open_")) return 0;
  if (strategyKey === "cash_secured_put") {
    const putLeg = payload.legs.find((leg) => leg.role === "option");
    return putLeg?.strike ? Math.max(0, putLeg.strike - putLeg.unitPrice) * 100 * putLeg.quantity : 0;
  }
  const stockLeg = payload.legs.find((leg) => leg.role === "stock");
  const callLeg = payload.legs.find((leg) => leg.role === "option");
  return stockLeg ? stockLeg.quantity * Math.max(0, stockLeg.unitPrice - (callLeg?.unitPrice ?? 0)) : 0;
}

export interface InFlightTotals {
  totalNotional: number;
  tickerNotional: number;
}

/** Statuses the order gate counts as in flight: confirmed and not yet done. */
export const inFlightOrderRequestStatuses = ["confirmed", "submitted", "partially_filled", "cancel_requested"];

/**
 * order_requests (aliased orq) still committing capital: in flight, or filled with fills not yet recorded, i.e. not yet a
 * position either (orderFillsPendingSql).
 */
export function inFlightOrderRequestsQuery() {
  return db("order_requests as orq").where((builder) => builder.whereIn("orq.status", inFlightOrderRequestStatuses).orWhereRaw(orderFillsPendingSql("orq")));
}

async function loadInFlightNotionals(symbol: string, excludeOrderRequestId: string | undefined): Promise<InFlightTotals> {
  let query = inFlightOrderRequestsQuery().select("orq.request_type", "orq.payload");
  if (excludeOrderRequestId) query = query.whereNot("orq.id", excludeOrderRequestId);
  const rows: { request_type: string; payload: OrderRequestPayload }[] = await query;
  const totals: InFlightTotals = { totalNotional: 0, tickerNotional: 0 };
  for (const row of rows) {
    const notional = computeInFlightOrderNotional(row.request_type, row.payload);
    totals.totalNotional += notional;
    if (row.payload.symbol === symbol) totals.tickerNotional += notional;
  }
  return totals;
}

async function computeOrderNotionalForInput(input: OrderLimitsInput, spotPrice: number): Promise<number> {
  const needsShares = input.strategyKey === "covered_call" && input.rollFromStrike === undefined;
  return computeOrderNotional(input, spotPrice, needsShares ? await fetchAvailableUncoveredShares(input.tickerId) : 0);
}

export async function evaluateOrderLimits(input: OrderLimitsInput): Promise<OrderLimitsResult> {
  let account: Awaited<ReturnType<typeof fetchAccountSummary>>;
  let cashLockedInCsps: number;
  let existingTickerExposure: number;
  let settings: Awaited<ReturnType<typeof loadTradingSettings>>;
  let spotPrice: number | null;
  let inFlight: InFlightTotals;
  try {
    [account, cashLockedInCsps, existingTickerExposure, settings, spotPrice, inFlight] = await Promise.all([
      fetchAccountSummary(),
      computeCashLockedInCsps(),
      computeTickerExposure(input.symbol),
      loadTradingSettings(),
      resolveSpotPrice(input),
      loadInFlightNotionals(input.symbol, input.excludeOrderRequestId),
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

  const orderNotional = await computeOrderNotionalForInput(input, spotPrice);
  return evaluateOrderLimitFigures({ symbol: input.symbol, orderNotional, totalPortfolioValue, totalCashValue: account.totalCashValue, cashLockedInCsps, existingTickerExposure, inFlight, settings });
}

export interface OrderLimitFigures {
  symbol: string;
  orderNotional: number;
  /** Net liquidation value, > 0. */
  totalPortfolioValue: number;
  totalCashValue: number | null;
  cashLockedInCsps: number;
  existingTickerExposure: number;
  inFlight: InFlightTotals;
  settings: Pick<TradingSettings, "maxPositionPctOfPortfolio" | "maxConcentrationPerTickerPct" | "minCashReservePct">;
}

/** Pure: the three limits on figures already read (the live gate reads them from IBKR and the book; a backtest from its simulated book). */
export function evaluateOrderLimitFigures(figures: OrderLimitFigures): OrderLimitsResult {
  const { orderNotional, totalPortfolioValue, existingTickerExposure, inFlight, settings } = figures;
  const freeCash = Math.max(0, (figures.totalCashValue ?? 0) - figures.cashLockedInCsps - inFlight.totalNotional);
  const workingOrdersNote = inFlight.totalNotional > 0 ? ` (counting ${formatWholeDollars(inFlight.totalNotional)} of orders still working)` : "";

  const reasons: string[] = [];

  // Compared in dollars, not as fraction x 100 against the percentage: 0.07 * 100 is 7.000000000000001, which would block an order
  // sitting exactly at a 7% limit.
  const limitInDollars = (limitPct: number) => (limitPct * totalPortfolioValue) / 100;

  const positionSharePct = orderNotional / totalPortfolioValue;
  if (orderNotional > limitInDollars(settings.maxPositionPctOfPortfolio)) {
    reasons.push(`This order is ${formatPct(positionSharePct)} of portfolio value, above the ${settings.maxPositionPctOfPortfolio}% max position size.`);
  }

  const tickerExposureAfter = existingTickerExposure + inFlight.tickerNotional + orderNotional;
  const concentrationAfterPct = tickerExposureAfter / totalPortfolioValue;
  if (tickerExposureAfter > limitInDollars(settings.maxConcentrationPerTickerPct)) {
    reasons.push(`${figures.symbol} would be ${formatPct(concentrationAfterPct)} of portfolio value, above the ${settings.maxConcentrationPerTickerPct}% max concentration per ticker${workingOrdersNote}.`);
  }

  const cashAfter = freeCash - orderNotional;
  const cashReserveAfterPct = cashAfter / totalPortfolioValue;
  if (cashAfter < limitInDollars(settings.minCashReservePct)) {
    reasons.push(`Placing this order would leave only ${formatPct(cashReserveAfterPct)} of portfolio value as cash, below the ${settings.minCashReservePct}% min cash reserve${workingOrdersNote}.`);
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    details: {
      orderNotional,
      totalPortfolioValue,
      positionSharePct,
      concentrationAfterPct,
      cashReserveAfterPct,
      inFlightNotional: inFlight.totalNotional,
      limits: { maxPositionPctOfPortfolio: settings.maxPositionPctOfPortfolio, maxConcentrationPerTickerPct: settings.maxConcentrationPerTickerPct, minCashReservePct: settings.minCashReservePct },
    },
  };
}
