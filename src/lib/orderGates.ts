import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import type { DeltaComplianceResult } from "../ibkr/streamOrderLegQuote.js";
import { evaluateCloseGateForPosition, type CloseGateVerdict } from "./closeGate.js";
import { evaluateDeltaBandForOrderRequest } from "./deltaBandGate.js";
import { evaluateOrderLimits, type OrderLimitsResult, type OrderLimitsStrategyKey } from "./orderLimits.js";
import { fetchTradingBlockedReason } from "./tradingGate.js";

// THE gate every order passes before it is transmitted, whatever its origin (Signals, the position form, the
// chain, Genosuke): one evaluation, used by the confirm step (hard blocks), by the order preview that Genosuke
// shows on its card, and (piecewise) by the Order Review panel's live stream. Approved 2026-10-05: the same gates
// for every order. A block refuses the order; a warning is shown but never refuses.
//
// What runs, by order type:
//   every order        trading gate (worker bound to this environment's account)
//   open_* and roll    the three limits (max position, per-ticker concentration, min cash reserve), counting orders still working
//   open_* only        the delta band, from a live delta (fails closed when no live delta can be read)
//   close_position     the close gate (session open, live two-sided quotes on every leg, consistent wheel cycle)
// A close is not limit-checked: it only reduces exposure.

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
  tradingBlockedReason: string | null;
  evaluatedAt: string;
}

/** The limit-check input of an opening or rolling order, or null when the order is not limit-checked (closes, no option leg, no strategy). */
export function limitsInputFromOrderRequest(orderRequest: Pick<OrderRequestForGates, "id" | "request_type" | "payload">) {
  const requestType = orderRequest.request_type;
  const isRoll = requestType === "roll_leg";
  if (!requestType.startsWith("open_") && !isRoll) return null;
  const payload = orderRequest.payload;
  const strategyKey = payload.strategyKey;
  if (strategyKey !== "covered_call" && strategyKey !== "cash_secured_put") return null;
  // A roll is one combo with two option legs: the close leg carries positionLegId, the open leg does not. Only the strike difference adds notional.
  const optionLeg = isRoll ? payload.legs.find((leg) => leg.role === "option" && !leg.positionLegId) : payload.legs.find((leg) => leg.role === "option");
  const closeLeg = isRoll ? payload.legs.find((leg) => leg.role === "option" && leg.positionLegId) : undefined;
  if (!optionLeg || !optionLeg.strike || (isRoll && !closeLeg?.strike)) return null;
  return { strategyKey: strategyKey as OrderLimitsStrategyKey, symbol: payload.symbol, quantity: optionLeg.quantity, strike: optionLeg.strike, rollFromStrike: closeLeg?.strike, excludeOrderRequestId: orderRequest.id };
}

/** Null when the order is not limit-checked; otherwise the shared limits verdict. A ticker unknown to the platform fails closed. */
export async function evaluateOrderLimitsForOrderRequest(
  orderRequest: Pick<OrderRequestForGates, "id" | "request_type" | "payload">,
  live: { spotPrice?: number } = {},
): Promise<OrderLimitsResult | null> {
  const input = limitsInputFromOrderRequest(orderRequest);
  if (!input) return null;
  const ticker = await db("tickers").where({ symbol: input.symbol.trim().toUpperCase() }).first("id", "symbol");
  if (!ticker) return { blocked: true, reasons: [`Could not verify position limits: ${input.symbol} is not a known ticker.`] };
  return evaluateOrderLimits({ ...input, symbol: ticker.symbol, tickerId: ticker.id, spotPrice: live.spotPrice });
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
  warnings: string[];
}): { blocks: string[]; warnings: string[] } {
  const blocks: string[] = [];
  if (parts.tradingBlockedReason) blocks.push(parts.tradingBlockedReason);
  if (parts.limits?.blocked) blocks.push(...parts.limits.reasons);
  if (parts.deltaBand && !parts.deltaBand.compliant) blocks.push(parts.deltaBand.reason ?? "The delta band could not be verified.");
  if (parts.closeGate?.blocked) blocks.push(parts.closeGate.reason ?? "Closing is blocked.");
  return { blocks, warnings: parts.warnings };
}

export async function evaluateOrderGates(orderRequest: OrderRequestForGates): Promise<OrderGateResult> {
  const closeGateWanted = orderRequest.request_type === "close_position" && Boolean(orderRequest.related_position_id);
  const [tradingBlockedReason, limits, deltaBand, closeGate] = await Promise.all([
    fetchTradingBlockedReason(),
    evaluateOrderLimitsForOrderRequest(orderRequest),
    evaluateDeltaBandForOrderRequest(orderRequest),
    closeGateWanted ? evaluateCloseGateForPosition(orderRequest.related_position_id!) : Promise.resolve(null),
  ]);
  const combined = combineOrderGateVerdicts({ tradingBlockedReason, limits, deltaBand, closeGate, warnings: describeCalendarWarnings(orderRequest) });
  return { ...combined, limits, deltaBand, closeGate, tradingBlockedReason, evaluatedAt: new Date().toISOString() };
}
