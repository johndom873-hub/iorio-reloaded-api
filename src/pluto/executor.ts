import { db } from "../db/connection.js";
import { InternalApiClient, InternalApiError } from "../lib/internalApiClient.js";
import { finalOrderRequestStatuses, isFinalOrderRequestStatus } from "../lib/orderRequestStatuses.js";
import { notifyTelegram } from "../lib/notifyTelegram.js";
import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { HeldLegScore, RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { PlutoDecision } from "./decisionSchema.js";
import { recordPlutoEvent, updatePlutoAction, type PlutoActionOutcome } from "./ledger.js";
import type { PlutoOrderPlan } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";
import { tripPlutoBreaker } from "./stateStore.js";

// Execution (design round 3, items 6 and 22): the agent never writes an order row itself. It builds
// through the same routes the screens use — POST /positions/orders or /positions/:id/roll — with the
// scores snapshot and its pluto_action_id, confirms with Adaptive Normal, then watches the order and
// cancels it if IBKR has not filled it within the timeout. Every route gate (halt, delta band, limits,
// active-order conflict, 15-minute staleness) runs on the way, and a refusal is a blocked action, never
// a retry. An order error or rejection trips the order_error breaker: a human looks before Pluto acts again.

interface OrderRequestResponse {
  id: string;
  status: string;
  payload?: { legs?: { role: "stock" | "option"; action: string; unitPrice: number }[] };
  errorMessage: string | null;
}

export interface ExecuteOpenInput {
  kind: "open";
  actionId: string;
  symbol: string;
  candidate: SignalCandidate;
  plan: PlutoOrderPlan;
  decision: PlutoDecision;
  scoresSnapshot: unknown;
}

export interface ExecuteRollInput {
  kind: "roll";
  actionId: string;
  symbol: string;
  roll: RollSignalCandidate;
  heldLeg: HeldLegScore;
  plan: PlutoOrderPlan;
  decision: PlutoDecision;
  scoresSnapshot: unknown;
}

export type ExecuteInput = ExecuteOpenInput | ExecuteRollInput;

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
}

function isoToIbkrExpiry(expiryIso: string): string {
  return expiryIso.replace(/-/g, "");
}

function describeOrder(input: ExecuteInput): string {
  if (input.kind === "open") {
    const right = input.candidate.strategyKey === "covered_call" ? "C" : "P";
    return `${input.symbol} ${input.plan.quantity}× $${input.candidate.strike}${right} ${input.candidate.expiry} @ ${input.plan.limitPrice.toFixed(2)}`;
  }
  return `${input.symbol} roll ${input.plan.quantity}× $${input.heldLeg.strike} → $${input.roll.replacement.strike} ${input.roll.replacement.expiry} @ ${input.plan.limitPrice.toFixed(2)}`;
}

/** Builds and confirms; returns once IBKR has the order (confirmed) or the route refused it (blocked). */
export async function executePlutoOrder(api: InternalApiClient, settings: PlutoSettings, input: ExecuteInput): Promise<ExecuteResult> {
  const description = describeOrder(input);
  let built: OrderRequestResponse;
  try {
    if (input.kind === "open") {
      built = await api.post<OrderRequestResponse>("/positions/orders", {
        symbol: input.symbol,
        strategyKey: input.candidate.strategyKey,
        option: { quantity: input.plan.quantity, limitPrice: input.plan.limitPrice, strikePrice: input.candidate.strike, expiryDate: isoToIbkrExpiry(input.candidate.expiry) },
        signalSnapshot: input.scoresSnapshot,
        plutoActionId: input.actionId,
      });
    } else {
      const held = input.heldLeg;
      const closeLimitPrice = held.bid !== null && held.ask !== null ? Math.round(((held.bid + held.ask) / 2) * 100) / 100 : null;
      if (closeLimitPrice === null) return await blocked(input, "the held leg has no live two-sided quote to price the buyback");
      built = await api.post<OrderRequestResponse>(`/positions/${input.roll.positionId}/roll`, {
        closeLegId: input.roll.legId,
        closeLimitPrice,
        newLeg: { strikePrice: input.roll.replacement.strike, expiryDate: isoToIbkrExpiry(input.roll.replacement.expiry), quantity: input.plan.quantity, limitPrice: input.plan.limitPrice },
        signalSnapshot: input.scoresSnapshot,
        plutoActionId: input.actionId,
      });
    }
  } catch (error) {
    if (error instanceof InternalApiError && (error.status === 400 || error.status === 404 || error.status === 409)) return await blocked(input, `build refused: ${error.message}`);
    return await errored(input, `build failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A buy-write's shares are priced by the route at the live price; a roll's buyback at the held leg's ask.
  const otherReferenceLegs: PlutoReferenceLeg[] =
    input.kind === "open"
      ? (built.payload?.legs ?? []).filter((leg) => leg.role === "stock").map((leg) => ({ side: leg.action === "SELL" ? ("sell" as const) : ("buy" as const), price: Number(leg.unitPrice), multiplier: 1 }))
      : [{ side: "buy", price: input.heldLeg.ask!, multiplier: 100 }]; // a roll without a two-sided held quote was blocked above
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
  if (settings.telegramVerbosity !== "off") await notifyTelegram(`🪐 Pluto sent an order: ${description}\n${input.decision.reasons.join(" ")}`);
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
    await notifyTelegram(`🛑 Pluto breaker tripped (order_error): ${reason}. Pluto is paused until a human resets it.`);
    return { outcome: "error", orderId, detail: reason };
  }
}

export interface ExecuteCloseInput {
  actionId: string;
  symbol: string;
  positionId: string;
  legs: { legId: string; limitPrice: number }[];
  description: string;
  reasons: string[];
}

/** Closes through POST /positions/:id/close (the server-side close gate runs there and again at confirm). */
export async function executePlutoClose(api: InternalApiClient, settings: PlutoSettings, input: ExecuteCloseInput): Promise<ExecuteResult> {
  let built: OrderRequestResponse;
  try {
    built = await api.post<OrderRequestResponse>(`/positions/${input.positionId}/close`, { legs: input.legs, plutoActionId: input.actionId });
  } catch (error) {
    if (error instanceof InternalApiError && (error.status === 400 || error.status === 404 || error.status === 409)) return await closeBlocked(`build refused: ${error.message}`);
    return await closeErrored(`build failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await updatePlutoAction(input.actionId, { outcome: "order_built", orderRequestId: built.id });
  await recordPlutoEvent("order_built", { actionId: input.actionId, orderId: built.id, symbol: input.symbol, description: input.description });
  try {
    const confirmed = await api.post<OrderRequestResponse>(`/positions/orders/${built.id}/confirm`, { adaptivePriority: "Normal" });
    if (confirmed.status === "pending_confirmation") return await closeBlocked("confirm did not move the order", built.id);
  } catch (error) {
    await api.post(`/positions/orders/${built.id}/cancel`, {}).catch(() => {});
    if (error instanceof InternalApiError && error.status === 409) return await closeBlocked(`confirm refused: ${error.message}`, built.id);
    return await closeErrored(`confirm failed: ${error instanceof Error ? error.message : String(error)}`, built.id);
  }
  await updatePlutoAction(input.actionId, { outcome: "confirmed" });
  await recordPlutoEvent("order_confirmed", { actionId: input.actionId, orderId: built.id, symbol: input.symbol, description: input.description });
  if (settings.telegramVerbosity !== "off") await notifyTelegram(`🪐 Pluto sent a close: ${input.description}\n${input.reasons.join(" ")}`);
  return { outcome: "confirmed", orderId: built.id, detail: input.description };

  async function closeBlocked(reason: string, orderId: string | null = null): Promise<ExecuteResult> {
    await updatePlutoAction(input.actionId, { outcome: "blocked", blockReason: reason, orderRequestId: orderId });
    await recordPlutoEvent("action_blocked", { actionId: input.actionId, symbol: input.symbol, reason, stage: "route" });
    return { outcome: "blocked", orderId, detail: reason };
  }
  async function closeErrored(reason: string, orderId: string | null = null): Promise<ExecuteResult> {
    await updatePlutoAction(input.actionId, { outcome: "error", blockReason: reason, orderRequestId: orderId });
    await recordPlutoEvent("order_outcome", { actionId: input.actionId, symbol: input.symbol, outcome: "error", reason });
    await tripPlutoBreaker("order_error", reason);
    await recordPlutoEvent("breaker_tripped", { name: "order_error", detail: reason });
    await notifyTelegram(`🛑 Pluto breaker tripped (order_error): ${reason}. Pluto is paused until a human resets it.`);
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
  /** Reference net minus fill net: what the fill would have been worth at the worse side of each leg's market. */
  pessimisticPnl: number;
}

/**
 * Pure: compares an order's fills with its reference on the net (Marcelo, 2026-09-29). A guaranteed
 * combo fills at its net limit but IBKR splits that net between the legs its own way, so only the net
 * is meaningful. Each reference leg takes the fills with its side and multiplier (unique per leg in
 * every order Pluto sends: one option, a buy-write's shares + call, a roll's buyback + new option).
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
    pessimisticPnl: Math.round(shortfall * 100) / 100,
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
}

/** Pure: the watch reference for an order found working after a restart, rebuilt from its action row. */
export function referenceForAdoptedOrder(action: { kind: string; symbol: string; reference_bid: unknown; reference_mid: unknown; limit_price: unknown; quantity: unknown; contract: unknown; reference_other_legs?: unknown }): AdoptableOrder["reference"] & { description: string } {
  const num = (value: unknown) => (value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));
  const price = num(action.reference_bid) ?? num(action.reference_mid) ?? num(action.limit_price) ?? 0;
  const side: "sell" | "buy" = action.kind === "close_leg" ? "buy" : "sell";
  const multiplier = action.kind === "close_shares" ? 1 : 100;
  const contract = (action.contract ?? {}) as { strike?: number; expiry?: string; strategyKey?: string };
  const description = `${action.symbol} ${num(action.quantity) ?? ""}× ${action.kind}${contract.strike !== undefined ? ` $${contract.strike}` : ""}${contract.expiry ? ` ${contract.expiry}` : ""}`.replace(/\s+/g, " ").trim();
  const otherLegs = Array.isArray(action.reference_other_legs) ? (action.reference_other_legs as PlutoReferenceLeg[]) : undefined;
  return { price, side, multiplier, ...(otherLegs ? { otherLegs } : {}), description };
}

/** Pluto orders IBKR may still be working: everything with a pluto_action_id that is not final. */
export async function loadWorkingPlutoOrders(): Promise<AdoptableOrder[]> {
  const rows: { id: string; status: string; created_at: Date; action_id: string; kind: string; symbol: string; reference_bid: unknown; reference_mid: unknown; limit_price: unknown; quantity: unknown; contract: unknown; reference_other_legs: unknown }[] = await db("order_requests as o")
    .join("pluto_actions as a", "a.id", "o.pluto_action_id")
    .whereNotIn("o.status", finalOrderRequestStatuses)
    .select("o.id", "o.status", "o.created_at", "a.id as action_id", "a.kind", "a.symbol", "a.reference_bid", "a.reference_mid", "a.limit_price", "a.quantity", "a.contract", "a.reference_other_legs");
  return rows.map((row) => {
      const { description, ...reference } = referenceForAdoptedOrder(row);
      return { orderId: row.id, actionId: row.action_id, symbol: row.symbol, kind: row.kind, createdAtMs: new Date(row.created_at).getTime(), reference, description };
    });
}

/**
 * Pure: for a two-part order, the chosen leg's price implied by the net fill, counting the other legs
 * at the prices we set on them in the order (Marcelo, 2026-09-29) — e.g. a buy-write IBKR reported as
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
  const rows: { side: string; quantity: number; price: string; multiplier: number | string }[] = await db("trades as t")
    .join("position_legs as pl", "pl.id", "t.position_leg_id")
    .where("t.source_order_request_id", orderId)
    .select("t.side", "t.quantity", "t.price", "pl.multiplier");
  return rows.map((row) => ({ side: row.side.toLowerCase() === "buy" ? "buy" : "sell", quantity: Number(row.quantity), price: Number(row.price), multiplier: Number(row.multiplier) }));
}

/**
 * Polls the order until IBKR is done with it or the timeout passes (then asks for a cancel and keeps
 * polling until the cancel lands). Records the outcome, the fill price and the pessimistic-fill gap.
 */
export async function watchPlutoOrder(
  api: InternalApiClient,
  settings: PlutoSettings,
  input: { actionId: string; orderId: string; symbol: string; reference: PlutoFillReference; description: string; cancelByMs?: number | null; startedAtMs?: number },
  options: { pollIntervalMs?: number; now?: () => number } = {},
): Promise<WatchResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  // An adopted order (agent restarted while it was working) keeps its original clock.
  const startedAt = input.startedAtMs ?? now();
  // Unfilled orders are cancelled after the configured minutes, or before the session close if that comes first.
  const cancelAtMs = Math.min(startedAt + settings.unfilledCancelMinutes * 60_000, input.cancelByMs ?? Number.POSITIVE_INFINITY);
  let cancelRequested = false;
  let missingFillPolls = 0;
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
      // Pessimistic bracket (design 2026-09-28): the P&L difference had the order filled at the worse side of
      // the market it was placed into (the bid for a sell, the ask for a buy) instead of where it did fill —
      // on the net for a combo (compareFillsWithReference).
      const filledStatus = order.status === "filled" || order.status === "cancelled_partially_filled";
      const fills = filledStatus ? await loadOrderFills(input.orderId) : [];
      const comparison = fills.length > 0 ? compareFillsWithReference(input.reference, fills) : null;
      // The status can land a moment before the executions are written: give them a few polls.
      if (filledStatus && comparison === null && missingFillPolls++ < 3) continue;
      const fillPrice = comparison?.chosenLegFillPrice ?? null;
      const impliedFillPrice = comparison ? impliedChosenLegPrice(input.reference, otherLegOrderPrices(input.reference, order.payload?.legs ?? []), fills) : null;
      const pessimisticPnl = comparison?.pessimisticPnl ?? null;
      await updatePlutoAction(input.actionId, { outcome, fillPrice, impliedFillPrice, pessimisticPnl, blockReason: order.errorMessage ?? null });
      await recordPlutoEvent("order_outcome", { actionId: input.actionId, orderId: input.orderId, symbol: input.symbol, outcome, fillPrice, error: order.errorMessage ?? undefined });
      if (outcome === "rejected" || outcome === "error") {
        const detail = `${input.description}: ${order.errorMessage ?? outcome}`;
        await tripPlutoBreaker("order_error", detail);
        await recordPlutoEvent("breaker_tripped", { name: "order_error", detail });
        await notifyTelegram(`🛑 Pluto breaker tripped (order_error): ${detail}. Pluto is paused until a human resets it.`);
      } else if (comparison !== null && comparison.slippagePct > settings.maxFillSlippagePct) {
        // Fill far from the reference (design breaker list): the market moved through the limit, or the limit
        // was wrong. Either way a human looks before the next order.
        const where = input.reference.otherLegs?.length
          ? `net ${comparison.fillNetDollars.toFixed(2)} vs reference net ${comparison.referenceNetDollars.toFixed(2)}`
          : `filled at ${comparison.chosenLegFillPrice.toFixed(2)} vs reference ${input.reference.price.toFixed(2)}`;
        const detail = `${input.description}: ${where} (${comparison.slippagePct.toFixed(1)}%${input.reference.otherLegs?.length ? " of the option's reference value" : ""} past it, limit ${settings.maxFillSlippagePct}%)`;
        await tripPlutoBreaker("fill_slippage", detail);
        await recordPlutoEvent("breaker_tripped", { name: "fill_slippage", detail });
        await notifyTelegram(`🛑 Pluto breaker tripped (fill_slippage): ${detail}. Pluto is paused until a human resets it.`);
      } else if (settings.telegramVerbosity !== "off") {
        const fillText = fillPrice === null ? "" : impliedFillPrice !== null ? ` (fill ${impliedFillPrice.toFixed(2)} implied by the net; IBKR split it as ${fillPrice.toFixed(2)})` : ` (avg fill ${fillPrice.toFixed(2)})`;
        await notifyTelegram(`🪐 Pluto order ${outcome}: ${input.description}${fillText}`);
      }
      return { outcome, detail: order.errorMessage ?? outcome };
    }
    if (!cancelRequested && now() > cancelAtMs) {
      cancelRequested = true;
      const why = input.cancelByMs !== null && input.cancelByMs !== undefined && cancelAtMs === input.cancelByMs ? "session close approaching" : `unfilled after ${settings.unfilledCancelMinutes} min`;
      try {
        await api.post(`/positions/orders/${input.orderId}/cancel`, {});
        await recordPlutoEvent("warning", { actionId: input.actionId, orderId: input.orderId, symbol: input.symbol, message: `${why} — cancel requested` });
      } catch (error) {
        console.warn(`Pluto watch: cancel request failed for ${input.orderId} — ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
