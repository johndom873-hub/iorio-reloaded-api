import { db } from "../db/connection.js";
import { InternalApiClient, InternalApiError } from "../lib/internalApiClient.js";
import { finalOrderRequestStatuses, isFinalOrderRequestStatus } from "../lib/orderRequestStatuses.js";
import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { fillsAreComplete, shouldWaitForFills } from "../lib/orderFills.js";
import { daysToExpiry, describeOptionContract, describeOrderSize, formatStrike } from "../lib/optionContractLabel.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { recordPlutoEvent, updatePlutoAction, type PlutoActionOutcome } from "./ledger.js";
import type { PlutoOrderPlan } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";
import { classifyRoutineOrderProblem, routineOrderProblemLabels } from "./routineOrderProblems.js";
import { tripPlutoBreaker } from "./stateStore.js";
import { followTheMidCheckIntervalSeconds, limitPriceChangeRefusalWindowSeconds, maxLimitPriceChangesPerOrder, type LimitPriceChange, type LimitPriceChangeRequest } from "../lib/orderLimitPriceChanges.js";
import { limitChangeableOrderStatuses } from "../lib/orderRequestStatuses.js";

/**
 * Follow the mid (Marcelo 2026-11-07): for a working single-leg option order, the price the strategy would send now, or null
 * to leave the order where it is (no usable live quote, the strategy's quote rules fail, Pluto paused). The watch asks every
 * followTheMidCheckIntervalSeconds and changes the order's limit when the price has moved by a cent or more.
 */
export interface PlutoFollowTheMid {
  priceNow(): Promise<number | null>;
}

// Execution (design round 3, items 6 and 22): the agent never writes an order row itself. It builds
// through the same route the screens use — POST /positions/orders — with the
// scores snapshot (live, fresh quotes only) and its pluto_action_id, confirms (Adaptive Normal on a single
// leg; a combo is a plain net-limit order), then watches the order and cancels it before the session close
// (the platform's unfilled-order sweep cancels it sooner when it sits unfilled). The order gate every order
// passes (halt, account binding, limits including working orders, delta band, close gate, limit-price check,
// active-order conflict, 15-minute staleness) runs on the way and again in the worker before placement; a
// refusal at the routes is a blocked action, never a retry. A routine problem once the order reached the worker (drifted
// price, missing quote, tick size, margin: routineOrderProblems.ts) is blocked too, and planned afresh at the next look;
// any other order error or rejection (the worker's other refusals included) trips the order_error breaker: a human looks
// before Pluto acts again.

interface OrderRequestResponse {
  id: string;
  status: string;
  payload?: { legs?: { role: "stock" | "option"; action: string; unitPrice: number; quantity: number }[]; limitPriceChangeRequest?: LimitPriceChangeRequest; limitPriceChanges?: LimitPriceChange[] };
  errorMessage: string | null;
  updatedAt?: string | null;
}

/** A sale opening a position (Vol Farmer v4's, volFarmerV4Round.ts): its contract and the shares it buys. */
export interface ExecuteStrategyOpenInput {
  kind: "strategy_open";
  actionId: string;
  symbol: string;
  strategyKey: "cash_secured_put" | "covered_call";
  contract: { expiry: string; strike: number; right: "C" | "P"; dte: number };
  plan: PlutoOrderPlan;
  /** A Covered Call entry buying every share its calls cover, uncovered shares held or not (the route's buyEveryShare). */
  buyEveryShare: boolean;
  reasons: string[];
  scoresSnapshot: unknown;
}

/** Vol Farmer v4's LEAPS purchase: a Call bought through the order route as a "leaps" position. */
export interface ExecuteLeapsPurchaseInput {
  kind: "leaps_buy";
  actionId: string;
  symbol: string;
  contract: { expiry: string; strike: number; right: "C"; dte: number };
  plan: PlutoOrderPlan;
  reasons: string[];
  scoresSnapshot: unknown;
}

/** Vol Farmer v4's LEAPS sale: one LEAPS position's leg sold whole through the close route. */
export interface ExecuteLeapsSaleInput {
  kind: "leaps_sell";
  actionId: string;
  symbol: string;
  positionId: string;
  legId: string;
  contract: { expiry: string; strike: number; right: "C"; dte: number };
  plan: PlutoOrderPlan;
  reasons: string[];
}

/**
 * Vol Farmer v4's share purchase (its rebalancing top-up, on a day it sells a Call: never a first position alone): shares bought
 * on their own through the order route (strategyKey "shares"); `plan.quantity` is the shares.
 */
export interface ExecuteSharesPurchaseInput {
  kind: "shares_buy";
  actionId: string;
  symbol: string;
  plan: PlutoOrderPlan;
  reasons: string[];
  scoresSnapshot: unknown;
}

/** Vol Farmer v4's trim: uncovered shares sold from the ticker's leftover-stock position through the close route; `plan.quantity` is the shares. */
export interface ExecuteSharesSaleInput {
  kind: "shares_sell";
  actionId: string;
  symbol: string;
  positionId: string;
  legId: string;
  plan: PlutoOrderPlan;
  reasons: string[];
}

/** Vol Farmer v4's buyback (Marcelo 2026-11-02): a Covered Call's Call bought back alone through the close route, its shares kept. */
export interface ExecuteCallBuyBackInput {
  kind: "call_buy_back";
  actionId: string;
  symbol: string;
  positionId: string;
  legId: string;
  contract: { expiry: string; strike: number; right: "C"; dte: number };
  plan: PlutoOrderPlan;
  reasons: string[];
}

export type ExecuteInput = ExecuteStrategyOpenInput | ExecuteLeapsPurchaseInput | ExecuteLeapsSaleInput | ExecuteSharesPurchaseInput | ExecuteSharesSaleInput | ExecuteCallBuyBackInput;

export interface ExecuteResult {
  outcome: PlutoActionOutcome;
  orderId: string | null;
  detail: string;
  /** A combo's legs other than the chosen option, priced for the fill comparison (see compareFillsWithReference). */
  otherReferenceLegs?: PlutoReferenceLeg[];
}

/** One leg's reference price: the worse side of its market (bid for a sell, ask for a buy). */
export interface PlutoReferenceLeg {
  side: "sell" | "buy";
  price: number;
  multiplier: number;
}

/** The chosen leg (the option Pluto picked, or the leg a close trades) plus, for a combo, its other legs. */
export interface PlutoFillReference extends PlutoReferenceLeg {
  otherLegs?: PlutoReferenceLeg[];
}

export interface PlutoFill {
  side: "sell" | "buy";
  quantity: number;
  price: number;
  multiplier: number;
  /** When IBKR executed it (trades.executed_at): a followed order's fill is judged against the limit IBKR held then. */
  executedAtMs?: number;
}

function isoToIbkrExpiry(expiryIso: string): string {
  return expiryIso.replace(/-/g, "");
}

/** "SMCI Sell $46 Call · 9 Oct (2DTE) · 11× @ 0.39"; a LEAPS purchase "Buy", a buyback "Buy back"; shares "AMD Buy 200 shares @ 254.10". */
export function describeOrder(input: ExecuteInput): string {
  if (input.kind === "shares_buy" || input.kind === "shares_sell") return `${input.symbol} ${input.kind === "shares_buy" ? "Buy" : "Sell"} ${input.plan.quantity} shares @ ${input.plan.limitPrice.toFixed(2)}`;
  return `${input.symbol} ${input.kind === "leaps_buy" ? "Buy" : input.kind === "call_buy_back" ? "Buy back" : "Sell"} ${describeOptionContract(input.contract)}${describeOrderSize(input.plan.quantity, input.plan.limitPrice)}`;
}

/** Builds the order through the route the screens use: a sale of a held leg or a buyback through the close route, everything else through POST /positions/orders. */
function buildOrder(api: InternalApiClient, input: ExecuteInput): Promise<OrderRequestResponse> {
  if (input.kind === "leaps_sell") return api.post<OrderRequestResponse>(`/positions/${input.positionId}/close`, { legs: [{ legId: input.legId, limitPrice: input.plan.limitPrice }], plutoActionId: input.actionId });
  if (input.kind === "shares_sell") return api.post<OrderRequestResponse>(`/positions/${input.positionId}/close`, { legs: [{ legId: input.legId, limitPrice: input.plan.limitPrice, quantity: input.plan.quantity }], plutoActionId: input.actionId });
  if (input.kind === "call_buy_back") return api.post<OrderRequestResponse>(`/positions/${input.positionId}/close`, { legs: [{ legId: input.legId, limitPrice: input.plan.limitPrice, quantity: input.plan.quantity }], keepShares: true, plutoActionId: input.actionId });
  if (input.kind === "shares_buy") return api.post<OrderRequestResponse>("/positions/orders", { symbol: input.symbol, strategyKey: "shares", stock: { quantity: input.plan.quantity, limitPrice: input.plan.limitPrice }, signalSnapshot: input.scoresSnapshot, plutoActionId: input.actionId });
  const option = { quantity: input.plan.quantity, limitPrice: input.plan.limitPrice, strikePrice: input.contract.strike, expiryDate: isoToIbkrExpiry(input.contract.expiry) };
  if (input.kind === "leaps_buy") return api.post<OrderRequestResponse>("/positions/orders", { symbol: input.symbol, strategyKey: "leaps", option, signalSnapshot: input.scoresSnapshot, plutoActionId: input.actionId });
  return api.post<OrderRequestResponse>("/positions/orders", {
    symbol: input.symbol,
    strategyKey: input.strategyKey,
    option,
    ...(input.buyEveryShare ? { buyEveryShare: true } : {}),
    signalSnapshot: input.scoresSnapshot,
    plutoActionId: input.actionId,
  });
}

/** Builds and confirms; returns once IBKR has the order (confirmed) or the route refused it (blocked). */
export async function executePlutoOrder(api: InternalApiClient, settings: PlutoSettings, input: ExecuteInput): Promise<ExecuteResult> {
  const description = describeOrder(input);
  let built: OrderRequestResponse;
  try {
    built = await buildOrder(api, input);
  } catch (error) {
    if (error instanceof InternalApiError && (error.status === 400 || error.status === 404 || error.status === 409)) return await blocked(input, `build refused: ${error.message}`);
    return await errored(input, `build failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A Covered Call entry's shares are priced by the route at the live price; an order of shares alone has no other leg.
  const sharesAlone = input.kind === "shares_buy" || input.kind === "shares_sell";
  const otherReferenceLegs: PlutoReferenceLeg[] = sharesAlone ? [] : (built.payload?.legs ?? []).filter((leg) => leg.role === "stock").map((leg) => ({ side: leg.action === "SELL" ? ("sell" as const) : ("buy" as const), price: Number(leg.unitPrice), multiplier: 1 }));
  await updatePlutoAction(input.actionId, { outcome: "order_built", orderRequestId: built.id, referenceOtherLegs: otherReferenceLegs.length > 0 ? otherReferenceLegs : null });
  await recordPlutoEvent("order_built", { actionId: input.actionId, orderId: built.id, symbol: input.symbol, description });

  try {
    const confirmed = await api.post<OrderRequestResponse>(`/positions/orders/${built.id}/confirm`, { adaptivePriority: "Normal" });
    if (confirmed.status === "pending_confirmation") return await blocked(input, "confirm did not move the order", built.id);
  } catch (error) {
    // The order row stays pending_confirmation; the stale sweep cancels it in 15 minutes, but be explicit now.
    await api.post(`/positions/orders/${built.id}/cancel`, {}).catch(() => {});
    if (error instanceof InternalApiError && error.status === 409) return await blocked(input, `confirm refused: ${error.message}`, built.id);
    return await errored(input, `confirm failed: ${error instanceof Error ? error.message : String(error)}`, built.id);
  }

  await updatePlutoAction(input.actionId, { outcome: "confirmed" });
  await recordPlutoEvent("order_confirmed", { actionId: input.actionId, orderId: built.id, symbol: input.symbol, description });
  if (settings.telegramVerbosity !== "off") await notifyPlutoTelegram(`🪐 Pluto sent an order: ${description}\n${input.reasons.join(" ")}`);
  return { outcome: "confirmed", orderId: built.id, detail: description, otherReferenceLegs };

  async function blocked(action: ExecuteInput, reason: string, orderId: string | null = null): Promise<ExecuteResult> {
    await updatePlutoAction(action.actionId, { outcome: "blocked", blockReason: reason, orderRequestId: orderId });
    await recordPlutoEvent("action_blocked", { actionId: action.actionId, symbol: action.symbol, reason, stage: "route" });
    return { outcome: "blocked", orderId, detail: reason };
  }

  async function errored(action: ExecuteInput, reason: string, orderId: string | null = null): Promise<ExecuteResult> {
    await updatePlutoAction(action.actionId, { outcome: "error", blockReason: reason, orderRequestId: orderId });
    await recordPlutoEvent("order_outcome", { actionId: action.actionId, symbol: action.symbol, outcome: "error", reason });
    await tripPlutoBreaker("order_error", reason);
    await recordPlutoEvent("breaker_tripped", { name: "order_error", detail: reason });
    await notifyPlutoTelegram(`🛑 Pluto breaker tripped (order_error): ${reason}. Pluto is paused until a human resets it.`);
    return { outcome: "error", orderId, detail: reason };
  }
}

export interface WatchResult {
  outcome: PlutoActionOutcome;
  detail: string;
}

/** Average fill price across this order's recorded executions, weighted by quantity; null until something filled. */
export interface FillComparison {
  /** Average fill of the chosen leg alone — for a combo, IBKR's split between the legs moves it. */
  chosenLegFillPrice: number;
  /** Signed dollars, credits positive, over the quantities that filled. */
  referenceNetDollars: number;
  fillNetDollars: number;
  /** Net shortfall against the reference as % of the chosen leg's reference value; positive = worse. */
  slippagePct: number;
}

/**
 * Pure: compares an order's fills with its reference on the net (Marcelo, 2026-09-29). A guaranteed
 * combo fills at its net limit but IBKR splits that net between the legs its own way, so only the net
 * is meaningful. Each reference leg takes the fills with its side and multiplier (unique per leg in
 * every order Pluto sends: one option, a Covered Call entry's shares + call, a roll's buyback + new option).
 * For a single leg this reduces to (reference − fill) / reference for a sell and the mirror for a buy.
 * Null until the chosen leg has a fill.
 */
export function compareFillsWithReference(reference: PlutoFillReference, fills: PlutoFill[]): FillComparison | null {
  const signed = (side: "sell" | "buy", dollars: number) => (side === "sell" ? dollars : -dollars);
  const legs = [{ leg: reference as PlutoReferenceLeg, chosen: true }, ...(reference.otherLegs ?? []).map((leg) => ({ leg, chosen: false }))];
  let referenceNetDollars = 0;
  let fillNetDollars = 0;
  let chosenQuantity = 0;
  let chosenFillValue = 0;
  for (const { leg, chosen } of legs) {
    const matched = fills.filter((fill) => fill.side === leg.side && fill.multiplier === leg.multiplier);
    const quantity = matched.reduce((sum, fill) => sum + fill.quantity, 0);
    referenceNetDollars += signed(leg.side, leg.price * quantity * leg.multiplier);
    fillNetDollars += matched.reduce((sum, fill) => sum + signed(fill.side, fill.price * fill.quantity * fill.multiplier), 0);
    if (chosen) {
      chosenQuantity = quantity;
      chosenFillValue = matched.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
    }
  }
  if (chosenQuantity === 0) return null;
  const chosenReferenceDollars = reference.price * chosenQuantity * reference.multiplier;
  const shortfall = referenceNetDollars - fillNetDollars;
  return {
    chosenLegFillPrice: chosenFillValue / chosenQuantity,
    referenceNetDollars,
    fillNetDollars,
    slippagePct: chosenReferenceDollars > 0 ? (shortfall / chosenReferenceDollars) * 100 : 0,
  };
}

/**
 * The limits IBKR may have held at a moment: the order's first limit, then each change IBKR accepted from its time on. A
 * moment inside the refusal window of a change may still have met the limit before it, so both are given.
 */
export function limitsInForceAt(firstLimit: number, changes: readonly LimitPriceChange[], atMs: number): number[] {
  let limit = firstLimit;
  let previous: number | null = null;
  let changedAtMs = Number.NEGATIVE_INFINITY;
  for (const change of [...changes].filter((entry) => entry.refused === undefined).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const changeAtMs = Date.parse(change.at);
    if (changeAtMs > atMs) break;
    previous = limit;
    limit = change.to;
    changedAtMs = changeAtMs;
  }
  return previous !== null && atMs - changedAtMs <= limitPriceChangeRefusalWindowSeconds * 1000 ? [previous, limit] : [limit];
}

/**
 * Pure: a followed single-leg order's fills, each against the limit IBKR held when it executed (Marcelo 2026-11-09), so
 * part filled at $1.05 and the rest at $1.29 after the limit moved is no slippage. Of two possible limits (a fill just
 * after a change) the one kinder to the fill counts. A fill with no execution time is judged against the last limit.
 * slippage % = Σ shortfall × quantity × multiplier / Σ limit × quantity × multiplier × 100, shortfall = limit − fill for a
 * sale and fill − limit for a purchase; positive = worse. Null until something filled.
 */
export function compareFillsWithOwnLimits(chosen: { side: "sell" | "buy"; multiplier: number }, fills: PlutoFill[], firstLimit: number, changes: readonly LimitPriceChange[]): (FillComparison & { averageLimitPrice: number }) | null {
  const matched = fills.filter((fill) => fill.side === chosen.side && fill.multiplier === chosen.multiplier);
  const quantity = matched.reduce((sum, fill) => sum + fill.quantity, 0);
  if (quantity === 0) return null;
  const signed = (dollars: number) => (chosen.side === "sell" ? dollars : -dollars);
  const lastLimit = limitsInForceAt(firstLimit, changes, Number.POSITIVE_INFINITY).at(-1)!;
  let limitDollars = 0;
  let fillDollars = 0;
  for (const fill of matched) {
    const candidates = fill.executedAtMs === undefined ? [lastLimit] : limitsInForceAt(firstLimit, changes, fill.executedAtMs);
    const limit = chosen.side === "sell" ? Math.min(...candidates) : Math.max(...candidates);
    limitDollars += limit * fill.quantity * chosen.multiplier;
    fillDollars += fill.price * fill.quantity * chosen.multiplier;
  }
  return {
    chosenLegFillPrice: fillDollars / (quantity * chosen.multiplier),
    averageLimitPrice: limitDollars / (quantity * chosen.multiplier),
    referenceNetDollars: signed(limitDollars),
    fillNetDollars: signed(fillDollars),
    slippagePct: limitDollars > 0 ? ((signed(limitDollars) - signed(fillDollars)) / limitDollars) * 100 : 0,
  };
}

export interface AdoptableOrder {
  orderId: string;
  actionId: string;
  symbol: string;
  kind: string;
  createdAtMs: number;
  reference: PlutoFillReference;
  description: string;
  /** What follow the mid needs to rebuild the order's rules (followTheMidOfAdoptedOrder). */
  executionStrategy: string | null;
  contract: unknown;
  legs: { role: "stock" | "option" }[];
}

/** The order an action row describes, in the platform's order wording; DTE counted from `todayIso`. */
export function describeActionOrder(action: { kind: string; symbol: string; limit_price: unknown; quantity: unknown; contract: unknown }, todayIso: string): string {
  const num = (value: unknown) => (value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));
  const quantity = num(action.quantity);
  const price = num(action.limit_price);
  const contract = (action.contract ?? {}) as { strike?: number; expiry?: string; strategyKey?: string; right?: string; fromStrike?: number; fromExpiry?: string };
  const right = contract.right ?? (contract.strategyKey === "covered_call" ? "C" : "P");
  const option = (strike: number | undefined, expiry: string | undefined, withDte: boolean) =>
    strike !== undefined && expiry ? describeOptionContract({ strike: Number(strike), right, expiry, dte: withDte ? daysToExpiry(expiry, todayIso) : null }) : `${strike !== undefined ? formatStrike(Number(strike)) : "?"} ${right === "C" ? "Call" : "Put"}`;
  if (action.kind === "close_shares" || action.kind === "buy_shares") return `${action.symbol} ${action.kind === "buy_shares" ? "Buy" : "Sell"} ${quantity ?? "?"} shares${price === null ? "" : ` @ ${price.toFixed(2)}`}`;
  // A close_position's quantity is its shares: one contract per 100.
  if (action.kind === "close_position") return `${action.symbol} Close ${option(contract.strike, contract.expiry, true)} + sell ${quantity ?? "?"} shares${quantity === null ? "" : ` · ${Math.round(quantity / 100)}×`}`;
  const size = quantity === null ? "" : describeOrderSize(quantity, price);
  if (action.kind === "roll") return `${action.symbol} Roll ${option(contract.fromStrike, contract.fromExpiry, false)} → ${option(contract.strike, contract.expiry, true)}${size}`;
  return `${action.symbol} ${action.kind === "close_leg" ? "Buy back" : action.kind === "buy_leaps" ? "Buy" : "Sell"} ${option(contract.strike, contract.expiry, true)}${size}`;
}

/** Pure: the watch reference for an order found working after a restart, rebuilt from its action row. */
export function referenceForAdoptedOrder(action: { kind: string; symbol: string; reference_bid: unknown; reference_mid: unknown; limit_price: unknown; quantity: unknown; contract: unknown; reference_other_legs?: unknown }, todayIso = easternIsoDate(new Date())): AdoptableOrder["reference"] & { description: string } {
  const num = (value: unknown) => (value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));
  const price = num(action.reference_bid) ?? num(action.reference_mid) ?? num(action.limit_price) ?? 0;
  const side: "sell" | "buy" = action.kind === "close_leg" || action.kind === "buy_leaps" || action.kind === "buy_shares" ? "buy" : "sell";
  // A close_position (a whole covered call) is referenced on its shares, the call being its other leg.
  const multiplier = action.kind === "close_shares" || action.kind === "buy_shares" || action.kind === "close_position" ? 1 : 100;
  const description = describeActionOrder(action, todayIso);
  const otherLegs = Array.isArray(action.reference_other_legs) ? (action.reference_other_legs as PlutoReferenceLeg[]) : undefined;
  return { price, side, multiplier, ...(otherLegs ? { otherLegs } : {}), description };
}

/** Pluto orders IBKR may still be working: everything with a pluto_action_id that is not final. */
export async function loadWorkingPlutoOrders(): Promise<AdoptableOrder[]> {
  const rows: { id: string; status: string; created_at: Date; payload: { legs?: { role: "stock" | "option" }[] } | null; action_id: string; kind: string; symbol: string; reference_bid: unknown; reference_mid: unknown; limit_price: unknown; quantity: unknown; contract: unknown; reference_other_legs: unknown; execution_strategy: string | null }[] = await db("order_requests as o")
    .join("pluto_actions as a", "a.id", "o.pluto_action_id")
    .whereNotIn("o.status", finalOrderRequestStatuses)
    .select("o.id", "o.status", "o.created_at", "o.payload", "a.id as action_id", "a.kind", "a.symbol", "a.reference_bid", "a.reference_mid", "a.limit_price", "a.quantity", "a.contract", "a.reference_other_legs", "a.execution_strategy");
  return rows.map((row) => {
      const { description, ...reference } = referenceForAdoptedOrder(row);
      return { orderId: row.id, actionId: row.action_id, symbol: row.symbol, kind: row.kind, createdAtMs: new Date(row.created_at).getTime(), reference, description, executionStrategy: row.execution_strategy, contract: row.contract, legs: row.payload?.legs ?? [] };
    });
}

/**
 * Pure: for a two-part order, the chosen leg's price implied by the net fill, counting the other legs
 * at the prices we set on them in the order (Marcelo, 2026-09-29) — e.g. a Covered Call entry IBKR reported as
 * call 6.86 / shares 327.48 against our 7.90 / 328.52 at the same net gives 7.90. Other legs take the
 * fills with their side and multiplier, as in compareFillsWithReference. Null for a single-leg order
 * or before the chosen leg has a fill.
 */
export function impliedChosenLegPrice(chosen: { side: "sell" | "buy"; multiplier: number }, otherLegOrderPrices: PlutoReferenceLeg[], fills: PlutoFill[]): number | null {
  if (otherLegOrderPrices.length === 0) return null;
  const signed = (side: "sell" | "buy", dollars: number) => (side === "sell" ? dollars : -dollars);
  const matching = (leg: { side: "sell" | "buy"; multiplier: number }) => fills.filter((fill) => fill.side === leg.side && fill.multiplier === leg.multiplier);
  const chosenFills = matching(chosen);
  const chosenQuantity = chosenFills.reduce((sum, fill) => sum + fill.quantity, 0);
  if (chosenQuantity === 0) return null;
  let otherLegsAtOrderDollars = 0;
  let fillNetDollars = chosenFills.reduce((sum, fill) => sum + signed(fill.side, fill.price * fill.quantity * fill.multiplier), 0);
  for (const leg of otherLegOrderPrices) {
    const legFills = matching(leg);
    otherLegsAtOrderDollars += signed(leg.side, leg.price * legFills.reduce((sum, fill) => sum + fill.quantity, 0) * leg.multiplier);
    fillNetDollars += legFills.reduce((sum, fill) => sum + signed(fill.side, fill.price * fill.quantity * fill.multiplier), 0);
  }
  const chosenDollars = fillNetDollars - otherLegsAtOrderDollars;
  return (chosen.side === "sell" ? chosenDollars : -chosenDollars) / (chosenQuantity * chosen.multiplier);
}

/** The order's legs other than the chosen one, at the prices we set on them (role → multiplier, action → side). */
export function otherLegOrderPrices(chosen: { side: "sell" | "buy"; multiplier: number }, orderLegs: { role: "stock" | "option"; action: string; unitPrice: number }[]): PlutoReferenceLeg[] {
  const legs = orderLegs.map((leg) => ({ side: leg.action === "SELL" ? ("sell" as const) : ("buy" as const), price: Number(leg.unitPrice), multiplier: leg.role === "stock" ? 1 : 100 }));
  if (legs.length < 2) return [];
  const chosenIndex = legs.findIndex((leg) => leg.side === chosen.side && leg.multiplier === chosen.multiplier);
  return legs.filter((_, index) => index !== chosenIndex);
}

/** Every execution recorded against the order, with its leg's multiplier (1 for shares, 100 for options). */
export async function loadOrderFills(orderId: string): Promise<PlutoFill[]> {
  const rows: { side: string; quantity: number; price: string; multiplier: number | string; executed_at: Date }[] = await db("trades as t")
    .join("position_legs as pl", "pl.id", "t.position_leg_id")
    .where("t.source_order_request_id", orderId)
    .select("t.side", "t.quantity", "t.price", "pl.multiplier", "t.executed_at");
  return rows.map((row) => ({ side: row.side.toLowerCase() === "buy" ? "buy" : "sell", quantity: Number(row.quantity), price: Number(row.price), multiplier: Number(row.multiplier), ...(Number.isFinite(new Date(row.executed_at).getTime()) ? { executedAtMs: new Date(row.executed_at).getTime() } : {}) }));
}

/**
 * Polls the order until IBKR is done with it or the timeout passes (then asks for a cancel and keeps
 * polling until the cancel lands). Records the outcome and the fill price, and checks the fill against the reference (fill_slippage).
 */
export async function watchPlutoOrder(
  api: InternalApiClient,
  settings: PlutoSettings,
  input: { actionId: string; orderId: string; symbol: string; reference: PlutoFillReference; description: string; cancelByMs?: number | null; startedAtMs?: number; followTheMid?: PlutoFollowTheMid },
  options: { pollIntervalMs?: number; now?: () => number } = {},
): Promise<WatchResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  // An adopted order (agent restarted while it was working) keeps its original clock.
  const startedAt = input.startedAtMs ?? now();
  // The platform's unfilled-order sweep (Risk & Limits) cancels an order left unfilled too long, Pluto's included
  // (Marcelo 2026-10-05). Pluto only adds the cancel shortly before the session close, which the sweep does not know.
  const cancelAtMs = input.cancelByMs ?? Number.POSITIVE_INFINITY;
  let cancelRequested = false;
  let nextFollowAtMs = startedAt + followTheMidCheckIntervalSeconds * 1000;
  let following = input.followTheMid !== undefined;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    let order: OrderRequestResponse;
    try {
      order = await api.get<OrderRequestResponse>(`/positions/orders/${input.orderId}`);
    } catch (error) {
      console.warn(`Pluto watch: could not read order ${input.orderId} — ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (isFinalOrderRequestStatus(order.status)) {
      const outcome = order.status as PlutoActionOutcome;
      // The fill against the order's reference, on the net for a combo (compareFillsWithReference).
      const filledStatus = order.status === "filled" || order.status === "cancelled_partially_filled";
      const fills = filledStatus ? await loadOrderFills(input.orderId) : [];
      const orderLegs = order.payload?.legs ?? [];
      // A new contract's fills are written only once the reconciliation creates its position: wait for all of them.
      if (filledStatus && shouldWaitForFills(order.status, orderLegs, fills, order.updatedAt ? new Date(order.updatedAt) : new Date(startedAt), now())) continue;
      // Judged only on complete fills: a roll recorded half-way would read as a huge slippage on one leg.
      // A followed order (or one adopted after its limit moved) is judged fill by fill against the limit IBKR held then.
      const limitChanges = order.payload?.limitPriceChanges ?? [];
      const followed = orderLegs.length === 1 && Number.isFinite(Number(orderLegs[0]!.unitPrice)) && (input.followTheMid !== undefined || limitChanges.length > 0);
      const firstLimit = followed ? (limitChanges[0]?.from ?? Number(orderLegs[0]!.unitPrice)) : null;
      const reference = followed ? { ...input.reference, price: Number(orderLegs[0]!.unitPrice) } : input.reference;
      const complete = fills.length > 0 && fillsAreComplete(order.status, orderLegs, fills);
      const ownLimitsComparison = complete && firstLimit !== null ? compareFillsWithOwnLimits(input.reference, fills, firstLimit, limitChanges) : null;
      const comparison = !complete ? null : firstLimit !== null ? ownLimitsComparison : compareFillsWithReference(reference, fills);
      if (filledStatus && comparison === null) await recordPlutoEvent("warning", { actionId: input.actionId, orderId: input.orderId, symbol: input.symbol, message: "the order's fills were not all recorded in time, so its fill price and slippage are not checked" });
      const fillPrice = comparison?.chosenLegFillPrice ?? null;
      const impliedFillPrice = comparison ? impliedChosenLegPrice(reference, otherLegOrderPrices(reference, order.payload?.legs ?? []), fills) : null;
      // A routine problem (routineOrderProblems.ts) is a blocked action, planned afresh at the next look: no breaker.
      const routineProblem = outcome === "rejected" || outcome === "error" ? classifyRoutineOrderProblem(order.errorMessage) : null;
      const routineReason = routineProblem === null ? null : `${routineOrderProblemLabels[routineProblem]}: ${order.errorMessage}`;
      await updatePlutoAction(input.actionId, { outcome: routineProblem === null ? outcome : "blocked", fillPrice, impliedFillPrice, blockReason: routineReason ?? order.errorMessage ?? null });
      await recordPlutoEvent("order_outcome", { actionId: input.actionId, orderId: input.orderId, symbol: input.symbol, outcome, fillPrice, error: order.errorMessage ?? undefined });
      if (routineReason !== null) {
        await recordPlutoEvent("action_blocked", { actionId: input.actionId, orderId: input.orderId, symbol: input.symbol, stage: "order", reason: routineReason });
        return { outcome: "blocked", detail: routineReason };
      }
      if (outcome === "rejected" || outcome === "error") {
        const detail = `${input.description}: ${order.errorMessage ?? outcome}`;
        await tripPlutoBreaker("order_error", detail);
        await recordPlutoEvent("breaker_tripped", { name: "order_error", detail });
        await notifyPlutoTelegram(`🛑 Pluto breaker tripped (order_error): ${detail}. Pluto is paused until a human resets it.`);
      } else if (comparison !== null && comparison.slippagePct > settings.maxFillSlippagePct) {
        // Fill far from the reference (design breaker list): the market moved through the limit, or the limit
        // was wrong. Either way a human looks before the next order.
        const where = input.reference.otherLegs?.length
          ? `net ${comparison.fillNetDollars.toFixed(2)} vs reference net ${comparison.referenceNetDollars.toFixed(2)}`
          : ownLimitsComparison !== null
            ? `filled at ${comparison.chosenLegFillPrice.toFixed(2)} vs its limit${limitChanges.length > 0 ? "s (average)" : ""} ${ownLimitsComparison.averageLimitPrice.toFixed(2)}`
            : `filled at ${comparison.chosenLegFillPrice.toFixed(2)} vs reference ${reference.price.toFixed(2)}`;
        const detail = `${input.description}: ${where} (${comparison.slippagePct.toFixed(1)}%${input.reference.otherLegs?.length ? " of the option's reference value" : ""} past it, limit ${settings.maxFillSlippagePct}%)`;
        await tripPlutoBreaker("fill_slippage", detail);
        await recordPlutoEvent("breaker_tripped", { name: "fill_slippage", detail });
        await notifyPlutoTelegram(`🛑 Pluto breaker tripped (fill_slippage): ${detail}. Pluto is paused until a human resets it.`);
      } else if (settings.telegramVerbosity !== "off") {
        const fillText = fillPrice === null ? "" : impliedFillPrice !== null ? ` (fill ${impliedFillPrice.toFixed(2)} implied by the net; IBKR split it as ${fillPrice.toFixed(2)})` : ` (avg fill ${fillPrice.toFixed(2)})`;
        await notifyPlutoTelegram(`🪐 Pluto order ${outcome}: ${input.description}${fillText}`);
      }
      return { outcome, detail: order.errorMessage ?? outcome };
    }
    if (following && !cancelRequested && now() >= nextFollowAtMs && now() <= cancelAtMs) {
      nextFollowAtMs = now() + followTheMidCheckIntervalSeconds * 1000;
      following = await followTheMidOnce(api, input, order);
    }
    if (!cancelRequested && now() > cancelAtMs) {
      cancelRequested = true;
      const why = "session close approaching";
      try {
        await api.post(`/positions/orders/${input.orderId}/cancel`, {});
        await recordPlutoEvent("warning", { actionId: input.actionId, orderId: input.orderId, symbol: input.symbol, message: `${why} — cancel requested` });
      } catch (error) {
        console.warn(`Pluto watch: cancel request failed for ${input.orderId} — ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

/**
 * One follow-the-mid check of a working order: asks the strategy's price now and, when it differs from the order's limit by
 * a cent or more, asks the route to change the limit (POST /positions/orders/:id/reprice). Answers whether to keep following:
 * not after the order's last allowed change, nor after the route refuses (halted, the lease lost, no longer working).
 */
export async function followTheMidOnce(api: InternalApiClient, input: { actionId: string; orderId: string; symbol: string; followTheMid?: PlutoFollowTheMid }, order: OrderRequestResponse): Promise<boolean> {
  const legs = order.payload?.legs ?? [];
  if (!input.followTheMid || legs.length !== 1 || !(limitChangeableOrderStatuses as readonly string[]).includes(order.status)) return true;
  if ((order.payload?.limitPriceChanges?.length ?? 0) >= maxLimitPriceChangesPerOrder) return false;
  // The worker has not sent the previous change yet.
  if (order.payload?.limitPriceChangeRequest) return true;
  const currentLimit = Number(legs[0]!.unitPrice);
  let priceNow: number | null;
  try {
    priceNow = await input.followTheMid.priceNow();
  } catch (error) {
    console.warn(`Pluto watch: no price now for order ${input.orderId} — ${error instanceof Error ? error.message : error}`);
    return true;
  }
  if (priceNow === null || Math.abs(priceNow - currentLimit) < 0.005) return true;
  try {
    await api.post(`/positions/orders/${input.orderId}/reprice`, { limitPrice: priceNow });
    await recordPlutoEvent("order_repriced", { actionId: input.actionId, orderId: input.orderId, symbol: input.symbol, from: currentLimit, to: priceNow });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof InternalApiError && error.status === 409) {
      await recordPlutoEvent("warning", { actionId: input.actionId, orderId: input.orderId, symbol: input.symbol, message: `the limit is no longer followed: ${detail}` });
      return false;
    }
    console.warn(`Pluto watch: changing the limit of ${input.orderId} failed — ${detail}`);
    return true;
  }
}
