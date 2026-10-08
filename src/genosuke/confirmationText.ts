// Plain-language text for Genosuke's Yes/Cancel cards, and the leg checks that
// run before a card is sent. Pure functions (no API calls) so they're unit
// tested; the tools in financialWriteTools.ts fetch the position and pass it in.
//
// Deliberately shows only the inputs the model chose (legs, sides, limit
// prices) — never a computed net credit/P&L, since financial formulas need
// explicit sign-off before they're implemented.

import { describeTradeContract, labelStrategy, tradeVerb } from "../lib/tradeMessageFormatting.js";

export interface PositionLeg {
  id: string;
  legType: "option" | "stock";
  side: "long" | "short";
  quantity: number;
  optionType: "call" | "put" | null;
  strikePrice: number | null;
  expiryDate: string | null;
  exitAt: string | null;
}

export interface PositionForCard {
  symbol: string;
  strategyKey: string;
  status: string;
  legs: PositionLeg[];
}

const riskSettingLabels: [string, string][] = [
  ["maxPositionPctOfPortfolio", "Max position % of portfolio"],
  ["maxConcentrationPerTickerPct", "Max concentration per ticker %"],
  ["minCashReservePct", "Min cash reserve %"],
  ["deltaTargetMin", "Delta band min"],
  ["deltaTargetMax", "Delta band max"],
  ["recoveryDteMin", "Recovery Path DTE min"],
  ["recoveryDteMax", "Recovery Path DTE max"],
  ["minAnnualizedYieldPct", "Min annualized yield %"],
  ["commissionWarnSharePctOfPremium", "Commission warning % of premium"],
  ["priceCheckMaxDeviationPct", "Limit-price check: max % off the live mid"],
  ["priceCheckMinToleranceDollars", "Limit-price check: minimum allowance $"],
  ["spreadCostChargedPct", "Signals spread cost % of the half-spread"],
  ["orderUnfilledCancelMinutes", "Cancel unfilled orders after (minutes, 0 = never)"],
];

function formatLimitPrice(limitPrice: unknown): string {
  const numeric = Number(limitPrice);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : String(limitPrice);
}

/** "$50 Put · 16 Oct (9DTE) · 1×" or "100 shares": the platform's contract wording, as in every trade message. */
export function describeLegContract(leg: PositionLeg): string {
  return describeTradeContract(leg);
}

/** What closing this leg means as an order: a short leg is bought back, a long leg is sold. */
function closingVerb(leg: PositionLeg): string {
  if (leg.side === "long") return "SELL";
  return leg.legType === "option" ? "BUY BACK" : "BUY";
}

function openLegs(position: PositionForCard): PositionLeg[] {
  return position.legs.filter((leg) => !leg.exitAt);
}

function positionHeading(verb: string, position: PositionForCard): string {
  return `${verb} ${position.symbol} (${labelStrategy(position.strategyKey)})`;
}

/** Returns an error for the model (no card is sent) if the legs aren't exactly the position's open legs. */
export function validateCloseLegs(position: PositionForCard, requestedLegs: { legId: string }[]): string | null {
  if (position.status !== "open") return `Position ${position.symbol} is already closed — nothing to close.`;

  const open = openLegs(position);
  const openById = new Map(open.map((leg) => [leg.id, leg]));
  const requestedIds = new Set(requestedLegs.map((leg) => leg.legId));

  const alreadyClosedOrUnknown = [...requestedIds].filter((legId) => !openById.has(legId));
  const missingOpen = open.filter((leg) => !requestedIds.has(leg.id));
  if (alreadyClosedOrUnknown.length === 0 && missingOpen.length === 0) return null;

  const problems: string[] = [];
  if (alreadyClosedOrUnknown.length > 0) {
    problems.push(`these legs are not open (already closed/expired, or unknown): ${alreadyClosedOrUnknown.join(", ")}`);
  }
  if (missingOpen.length > 0) {
    problems.push(`these open legs were left out: ${missingOpen.map((leg) => leg.id).join(", ")}`);
  }
  const correctLegs = open.map((leg) => `${leg.id} (${leg.side} ${describeLegContract(leg)})`).join("; ");
  return `Close not sent for confirmation: ${problems.join("; ")}. A close must include exactly the position's currently-open legs (isOpen: true): ${correctLegs}. Retry with only those.`;
}

/** One leg of an order as the server built it (the payload stored on the order_requests row). */
export interface BuiltOrderLeg {
  role: "stock" | "option";
  action: string;
  quantity: number;
  unitPrice: number;
  strike?: number;
  expiry?: string;
  right?: "C" | "P";
  /** Set on a leg that closes an existing position leg. */
  positionLegId?: string;
}

export interface BuiltOrderForCard {
  requestType: string;
  payload: { symbol: string; strategyKey?: string; legs: BuiltOrderLeg[] };
}

/** "• Sell $50 Put · 16 Oct (9DTE) · 2× @ 1.35 limit", "• Buy back …", "• Buy 100 shares @ 45.10 limit". */
function describeBuiltLeg(leg: BuiltOrderLeg): string {
  const verb = leg.role === "option" && leg.action === "BUY" && leg.positionLegId ? "Buy back" : tradeVerb(leg.action);
  const what = describeTradeContract({ legType: leg.role, quantity: leg.quantity, optionType: leg.right ? (leg.right === "C" ? "call" : "put") : null, strikePrice: leg.strike ?? null, expiryDate: leg.expiry ?? null });
  return `• ${verb} ${what} @ ${formatLimitPrice(leg.unitPrice)} limit`;
}

/**
 * The card for an order, written from the order the server actually built (the legs and limit prices that will be sent), never from what
 * the model asked for: whatever the server filled in (a covered call's buy-write stock leg, a rounded price) is on the card.
 */
export function buildOrderCard(order: BuiltOrderForCard): string {
  const { requestType, payload } = order;
  const verb = requestType === "close_position" ? "Close" : requestType === "roll_leg" ? "Roll" : "Place order for";
  const heading = `${verb} ${payload.symbol}${payload.strategyKey ? ` (${labelStrategy(payload.strategyKey)})` : ""}`;
  const shape = payload.legs.length > 1 ? "One combo order" : "One limit order";
  return [heading, ...payload.legs.map(describeBuiltLeg), `${shape}, sent to IBKR immediately when you tap Yes.`].join("\n");
}

/** The card for the trading halt switch. */
export function buildTradingHaltCard(enabled: boolean, reason: unknown): string {
  return enabled
    ? `HALT ALL TRADING: no order from any origin reaches IBKR until it is resumed (cancels still work). Reason: ${reason}`
    : `RESUME TRADING: orders reach IBKR again from every origin.${typeof reason === "string" && reason.trim() !== "" ? ` Reason: ${reason}` : ""}`;
}

/** The card for a trading-settings change: only the fields being changed, each as old → new when the current value is known. */
export function buildRiskLimitsCard(changes: Record<string, unknown>, current: Record<string, unknown> = {}): string {
  const lines = riskSettingLabels
    .filter(([key]) => changes[key] !== undefined)
    .map(([key, label]) => (current[key] !== undefined && current[key] !== changes[key] ? `• ${label}: ${current[key]} → ${changes[key]}` : `• ${label}: ${changes[key]}`));
  return ["Update the trading limits", ...lines].join("\n");
}

/** Adds isOpen to each leg so the model never has to infer it from exitAt. Non-position values pass through. */
export function annotateLegOpenState<T>(value: T): T {
  if (Array.isArray(value)) return value.map(annotateLegOpenState) as T;
  if (value && typeof value === "object" && Array.isArray((value as { legs?: unknown }).legs)) {
    const position = value as unknown as { legs: { exitAt?: string | null }[] };
    return { ...position, legs: position.legs.map((leg) => ({ ...leg, isOpen: !leg.exitAt })) } as T;
  }
  return value;
}
