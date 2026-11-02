import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import type { DeltaComplianceResult } from "../ibkr/streamOrderLegQuote.js";
import { evaluateCloseGateForPosition, type CloseGateVerdict } from "./closeGate.js";
import { evaluateDeltaBandForOrderRequest } from "./deltaBandGate.js";
import { evaluateStrategyDeltaForOrderRequest, type StrategyOrderGateContext } from "./strategyOrderGates.js";
import { evaluateLimitPriceCheckForOrderRequest } from "./limitPriceCheckGate.js";
import type { PriceCheckResult } from "./limitPriceCheck.js";
import { loadTraderCapitalFigures } from "./capitalOutsidePluto.js";
import { evaluateOrderLimits, type OrderLimitsResult, type OrderLimitsStrategyKey } from "./orderLimits.js";
import { fetchTradingBlockedReason } from "./tradingGate.js";

// THE gate every order passes before it is transmitted, whatever its origin (Signals, the position form, the
// chain, Pluto): one evaluation, used by the confirm step (hard blocks) and (piecewise)
// by the Order Review panel's live stream. Approved 2026-10-05: the same gates
// for every order. A block refuses the order; a warning is shown but never refuses.
//
// What runs, by order type:
//   every order        trading gate (worker bound to this environment's account)
//   open_* and roll    the three limits (max order size, per-ticker concentration, min cash reserve), counting orders still working,
//                      and for a trader's order the traders' capital cap (capitalOutsidePluto.ts)
//   open_* only        the delta band, from a live delta (fails closed when no live delta can be read)
//   close_position     the close gate (session open, live two-sided quotes on every leg, consistent wheel cycle)
//   every order        the limit-price check: each leg's limit against its own live mid (limitPriceCheck.ts)
// A close is not limit-checked: it only reduces exposure. A Pluto strategy order (its Pluto action taken under Vol Farmer
// v4) gets the strategy's delta range on its own delta and its pot cap instead of the delta band and the first two limits,
// and the book-wide cap on Pluto's capital budget (strategyOrderGates.ts; Marcelo 2026-10-15 and 2026-10-21). A Vol Farmer
// v4 share purchase (open_shares, no option leg) gets the limits on what it pays and no delta check.

export interface OrderRequestForGates {
  id: string;
  request_type: string;
  payload: OrderRequestPayload;
  related_position_id?: string | null;
  calendar_warning?: string | null;
  calendar_warning_events?: { title: string; eventDate: string }[] | null;
}

export interface OrderGateResult {
  blocks: string[];
  warnings: string[];
  limits: OrderLimitsResult | null;
  deltaBand: DeltaComplianceResult | null;
  closeGate: CloseGateVerdict | null;
  /** The limit-price check, with the live quotes it saw on each leg; null when the order has no legs. */
  priceCheck: PriceCheckResult | null;
  tradingBlockedReason: string | null;
  evaluatedAt: string;
}

/** The limit-check input of an opening or rolling order, or null when the order is not limit-checked (closes, no option leg, no strategy). */
export function limitsInputFromOrderRequest(orderRequest: Pick<OrderRequestForGates, "id" | "request_type" | "payload">, strategy: Pick<StrategyOrderGateContext, "potFraction" | "book"> | null = null) {
  const requestType = orderRequest.request_type;
  const isRoll = requestType === "roll_leg";
  if (!requestType.startsWith("open_") && !isRoll) return null;
  const payload = orderRequest.payload;
  const strategyKey = payload.strategyKey;
  // A share purchase (Vol Farmer v4's rebalancing): its shares at their limit.
  if (strategyKey === "shares") {
    const stockLeg = payload.legs.find((leg) => leg.role === "stock");
    if (requestType !== "open_shares" || !stockLeg) return null;
    return {
      strategyKey: "shares" as const,
      symbol: payload.symbol,
      quantity: stockLeg.quantity,
      strike: 0,
      premium: stockLeg.unitPrice,
      excludeOrderRequestId: orderRequest.id,
      ...(strategy ? { strategy: { potFraction: strategy.potFraction, stockSharesBought: 0, book: strategy.book } } : {}),
    };
  }
  if (strategyKey !== "covered_call" && strategyKey !== "cash_secured_put" && strategyKey !== "leaps") return null;
  // A roll is one combo with two option legs: the close leg carries positionLegId, the open leg does not. Only the strike difference adds notional.
  const optionLeg = isRoll ? payload.legs.find((leg) => leg.role === "option" && !leg.positionLegId) : payload.legs.find((leg) => leg.role === "option");
  const closeLeg = isRoll ? payload.legs.find((leg) => leg.role === "option" && leg.positionLegId) : undefined;
  if (!optionLeg || !optionLeg.strike || (isRoll && !closeLeg?.strike)) return null;
  const stockLegShares = payload.legs.find((leg) => leg.role === "stock")?.quantity;
  return {
    strategyKey: strategyKey as OrderLimitsStrategyKey,
    symbol: payload.symbol,
    quantity: optionLeg.quantity,
    strike: optionLeg.strike,
    premium: optionLeg.unitPrice,
    rollFromStrike: closeLeg?.strike,
    rollFromPremium: closeLeg?.unitPrice,
    excludeOrderRequestId: orderRequest.id,
    ...(stockLegShares !== undefined && !isRoll ? { stockSharesBought: stockLegShares } : {}),
    ...(strategy ? { strategy: { potFraction: strategy.potFraction, stockSharesBought: stockLegShares ?? 0, book: strategy.book } } : {}),
  };
}

/** Who the order is judged for: a trader's order also gets the traders' capital cap. */
export interface OrderGateOptions {
  forTrader?: boolean;
}

/** Null when the order is not limit-checked; otherwise the shared limits verdict. A ticker unknown to the platform fails closed. */
export async function evaluateOrderLimitsForOrderRequest(
  orderRequest: Pick<OrderRequestForGates, "id" | "request_type" | "payload">,
  live: { spotPrice?: number } = {},
  strategy: StrategyOrderGateContext | null = null,
  options: OrderGateOptions = {},
): Promise<OrderLimitsResult | null> {
  const input = limitsInputFromOrderRequest(orderRequest, strategy);
  if (!input) return null;
  const ticker = await db("tickers").where({ symbol: input.symbol.trim().toUpperCase() }).first("id", "symbol");
  if (!ticker) return { blocked: true, reasons: [`Could not verify position limits: ${input.symbol} is not a known ticker.`] };
  const loadTraderCapital = options.forTrader ? () => loadTraderCapitalFigures(orderRequest.id) : undefined;
  return evaluateOrderLimits({ ...input, symbol: ticker.symbol, tickerId: ticker.id, spotPrice: live.spotPrice, loadTraderCapital });
}

/** Pure: the calendar warnings stored on the order, as the Order Review panel words them. */
export function describeCalendarWarnings(orderRequest: Pick<OrderRequestForGates, "calendar_warning" | "calendar_warning_events">): string[] {
  const events = orderRequest.calendar_warning_events ?? [];
  if (events.length > 0) {
    const list = events.map((event) => `${event.eventDate} ${event.title}`).join("; ");
    return [`${events.length} economic event${events.length === 1 ? "" : "s"} before expiry: ${list}.`];
  }
  return orderRequest.calendar_warning ? [orderRequest.calendar_warning] : [];
}

/** Pure: folds the individual verdicts into blocks and warnings. */
export function combineOrderGateVerdicts(parts: {
  tradingBlockedReason: string | null;
  limits: OrderLimitsResult | null;
  deltaBand: DeltaComplianceResult | null;
  closeGate: CloseGateVerdict | null;
  priceCheck?: PriceCheckResult | null;
  warnings: string[];
}): { blocks: string[]; warnings: string[] } {
  const blocks: string[] = [];
  if (parts.tradingBlockedReason) blocks.push(parts.tradingBlockedReason);
  if (parts.limits?.blocked) blocks.push(...parts.limits.reasons);
  if (parts.deltaBand && !parts.deltaBand.compliant) blocks.push(parts.deltaBand.reason ?? "The delta band could not be verified.");
  if (parts.closeGate?.blocked) blocks.push(parts.closeGate.reason ?? "Closing is blocked.");
  if (parts.priceCheck?.blocked) blocks.push(...parts.priceCheck.reasons);
  return { blocks, warnings: parts.warnings };
}

/** `strategy`: Vol Farmer v4's context for an order its Pluto action took under it (null for every other order). */
export async function evaluateOrderGates(orderRequest: OrderRequestForGates, strategy: StrategyOrderGateContext | null = null, options: OrderGateOptions = {}): Promise<OrderGateResult> {
  const closeGateWanted = orderRequest.request_type === "close_position" && Boolean(orderRequest.related_position_id);
  const [tradingBlockedReason, limits, deltaBand, closeGate, priceCheck] = await Promise.all([
    fetchTradingBlockedReason(),
    evaluateOrderLimitsForOrderRequest(orderRequest, {}, strategy, options),
    strategy ? evaluateStrategyDeltaForOrderRequest(orderRequest, strategy) : evaluateDeltaBandForOrderRequest(orderRequest),
    closeGateWanted ? evaluateCloseGateForPosition(orderRequest.related_position_id!) : Promise.resolve(null),
    evaluateLimitPriceCheckForOrderRequest(orderRequest),
  ]);
  const combined = combineOrderGateVerdicts({ tradingBlockedReason, limits, deltaBand, closeGate, priceCheck, warnings: describeCalendarWarnings(orderRequest) });
  return { ...combined, limits, deltaBand, closeGate, priceCheck, tradingBlockedReason, evaluatedAt: new Date().toISOString() };
}
