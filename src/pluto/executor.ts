import { db } from "../db/connection.js";
import { InternalApiClient, InternalApiError } from "../lib/internalApiClient.js";
import { isOrderRequestFinal } from "../lib/orderRequestStatus.js";
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
  errorMessage: string | null;
  ibkrStatus?: string | null;
  filledQuantity?: number | null;
  remainingQuantity?: number | null;
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

  await updatePlutoAction(input.actionId, { outcome: "order_built", orderRequestId: built.id });
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
  return { outcome: "confirmed", orderId: built.id, detail: description };

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
/** Pure: how far past the reference a fill landed, as % of the reference — positive means worse than the reference (below the bid for a sell, above the ask for a buy). */
export function fillSlippagePct(reference: { price: number; side: "sell" | "buy" }, fillPrice: number): number {
  if (!(reference.price > 0)) return 0;
  const adverse = reference.side === "sell" ? reference.price - fillPrice : fillPrice - reference.price;
  return (adverse / reference.price) * 100;
}

export interface AdoptableOrder {
  orderId: string;
  actionId: string;
  symbol: string;
  kind: string;
  createdAtMs: number;
  reference: { price: number; side: "sell" | "buy"; multiplier: number };
  description: string;
}

/** Pure: the watch reference for an order found working after a restart, rebuilt from its action row. */
export function referenceForAdoptedOrder(action: { kind: string; symbol: string; reference_bid: unknown; reference_mid: unknown; limit_price: unknown; quantity: unknown; contract: unknown }): AdoptableOrder["reference"] & { description: string } {
  const num = (value: unknown) => (value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));
  const price = num(action.reference_bid) ?? num(action.reference_mid) ?? num(action.limit_price) ?? 0;
  const side: "sell" | "buy" = action.kind === "close_leg" ? "buy" : "sell";
  const multiplier = action.kind === "close_shares" ? 1 : 100;
  const contract = (action.contract ?? {}) as { strike?: number; expiry?: string; strategyKey?: string };
  const description = `${action.symbol} ${num(action.quantity) ?? ""}× ${action.kind}${contract.strike !== undefined ? ` $${contract.strike}` : ""}${contract.expiry ? ` ${contract.expiry}` : ""}`.replace(/\s+/g, " ").trim();
  return { price, side, multiplier, description };
}

/** Pluto orders IBKR may still be working: everything with a pluto_action_id that is not final. */
export async function loadWorkingPlutoOrders(): Promise<AdoptableOrder[]> {
  const rows: { id: string; status: string; ibkr_status: string | null; created_at: Date; action_id: string; kind: string; symbol: string; reference_bid: unknown; reference_mid: unknown; limit_price: unknown; quantity: unknown; contract: unknown }[] = await db("order_requests as o")
    .join("pluto_actions as a", "a.id", "o.pluto_action_id")
    .whereNotIn("o.status", ["filled", "cancelled", "rejected", "error"])
    .select("o.id", "o.status", "o.ibkr_status", "o.created_at", "a.id as action_id", "a.kind", "a.symbol", "a.reference_bid", "a.reference_mid", "a.limit_price", "a.quantity", "a.contract");
  return rows
    .filter((row) => !isOrderRequestFinal({ status: row.status, ibkr_status: row.ibkr_status }))
    .map((row) => {
      const reference = referenceForAdoptedOrder(row);
      return { orderId: row.id, actionId: row.action_id, symbol: row.symbol, kind: row.kind, createdAtMs: new Date(row.created_at).getTime(), reference: { price: reference.price, side: reference.side, multiplier: reference.multiplier }, description: reference.description };
    });
}

export async function averageFillPrice(orderId: string): Promise<number | null> {
  const row = await db("trades").where({ source_order_request_id: orderId }).select(db.raw("sum(price * quantity) / nullif(sum(quantity), 0) as avg_price")).first();
  return row?.avg_price === null || row?.avg_price === undefined ? null : Number(row.avg_price);
}

/**
 * Polls the order until IBKR is done with it or the timeout passes (then asks for a cancel and keeps
 * polling until the cancel lands). Records the outcome, the fill price and the pessimistic-fill gap.
 */
export async function watchPlutoOrder(
  api: InternalApiClient,
  settings: PlutoSettings,
  input: { actionId: string; orderId: string; symbol: string; reference: { price: number; side: "sell" | "buy"; multiplier: number }; description: string; cancelByMs?: number | null; startedAtMs?: number },
  options: { pollIntervalMs?: number; now?: () => number } = {},
): Promise<WatchResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  // An adopted order (agent restarted while it was working) keeps its original clock.
  const startedAt = input.startedAtMs ?? now();
  // Unfilled orders are cancelled after the configured minutes, or before the session close if that comes first.
  const cancelAtMs = Math.min(startedAt + settings.unfilledCancelMinutes * 60_000, input.cancelByMs ?? Number.POSITIVE_INFINITY);
  let cancelRequested = false;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    let order: OrderRequestResponse;
    try {
      order = await api.get<OrderRequestResponse>(`/positions/orders/${input.orderId}`);
    } catch (error) {
      console.warn(`Pluto watch: could not read order ${input.orderId} — ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (isOrderRequestFinal({ status: order.status, ibkr_status: order.ibkrStatus ?? null })) {
      const outcome = order.status as PlutoActionOutcome;
      const fillPrice = order.status === "filled" || order.status === "partially_filled" ? await averageFillPrice(input.orderId) : null;
      // Pessimistic bracket (design 2026-09-28): the P&L difference had the order filled at the worse side of
      // the market it was placed into (the bid for a sell, the ask for a buy) instead of where it did fill.
      const filledUnits = (order.filledQuantity ?? 1) * input.reference.multiplier;
      const pessimisticPnl = fillPrice === null ? null : Math.round((input.reference.side === "sell" ? input.reference.price - fillPrice : fillPrice - input.reference.price) * filledUnits * 100) / 100;
      await updatePlutoAction(input.actionId, { outcome, fillPrice, pessimisticPnl, blockReason: order.errorMessage ?? null });
      await recordPlutoEvent("order_outcome", { actionId: input.actionId, orderId: input.orderId, symbol: input.symbol, outcome, fillPrice, error: order.errorMessage ?? undefined });
      if (outcome === "rejected" || outcome === "error") {
        const detail = `${input.description}: ${order.errorMessage ?? outcome}`;
        await tripPlutoBreaker("order_error", detail);
        await recordPlutoEvent("breaker_tripped", { name: "order_error", detail });
        await notifyTelegram(`🛑 Pluto breaker tripped (order_error): ${detail}. Pluto is paused until a human resets it.`);
      } else if (fillPrice !== null && fillSlippagePct(input.reference, fillPrice) > settings.maxFillSlippagePct) {
        // Fill far from the reference (design breaker list): the market moved through the limit, or the limit
        // was wrong. Either way a human looks before the next order.
        const detail = `${input.description}: filled at ${fillPrice.toFixed(2)} vs reference ${input.reference.price.toFixed(2)} (${fillSlippagePct(input.reference, fillPrice).toFixed(1)}% past it, limit ${settings.maxFillSlippagePct}%)`;
        await tripPlutoBreaker("fill_slippage", detail);
        await recordPlutoEvent("breaker_tripped", { name: "fill_slippage", detail });
        await notifyTelegram(`🛑 Pluto breaker tripped (fill_slippage): ${detail}. Pluto is paused until a human resets it.`);
      } else if (settings.telegramVerbosity !== "off") {
        await notifyTelegram(`🪐 Pluto order ${outcome}: ${input.description}${fillPrice !== null ? ` (avg fill ${fillPrice.toFixed(2)})` : ""}`);
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
