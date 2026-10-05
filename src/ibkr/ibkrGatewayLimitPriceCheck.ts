import type { IBApi } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { describeOrderLegForPriceCheck, evaluateLimitPrices, type PriceCheckResult } from "../lib/limitPriceCheck.js";
import { publishNotification } from "../lib/notificationChannel.js";
import { loadPriceCheckTolerance } from "../lib/tradingSettingsStore.js";
import { fetchLegQuoteSnapshots, type LegQuoteSnapshotResult } from "./ibkrGatewayLegQuotes.js";
import type { OrderRequestPayload } from "./ibkrGatewayOrderPayload.js";

// Runs on the VPS worker: the limit-price check (lib/limitPriceCheck.ts) repeated right before an order is placed, from a real-time
// IBKR snapshot taken on the worker's own connection. The confirm step already judged the price from the web dyno's quotes; this
// catches a price that drifted since, and an order that reached the worker some other way. Fail closed: no quote, an unreadable
// setting or any failure ends the order as an error for good, like the other placement checks (lib/orderPlacementEnforcement.ts).

export interface LimitPriceBlock {
  reason: string;
  /** False when the row was no longer `confirmed` by the time it was ended (a cancel landed first), so it keeps its own status. */
  ended: boolean;
}

export interface LimitPriceCheckDependencies {
  fetchQuotes(legs: OrderRequestPayload["legs"]): Promise<LegQuoteSnapshotResult>;
}

/** The refusal text: the check's reasons, plus whatever IBKR said that explains a missing quote. */
export function describeLimitPriceRefusal(result: PriceCheckResult, notes: string[]): string {
  const base = `The order's limit price failed the live-quote check at placement: ${result.reasons.join(" ")}`;
  return notes.length > 0 ? `${base} (${notes.join("; ")})` : base;
}

export async function endOrderIfLimitPriceUnsafe(
  orderRequest: { id: string; payload: OrderRequestPayload },
  ib: Pick<IBApi, "on" | "removeListener" | "reqMarketDataType" | "reqMktData" | "cancelMktData">,
  dependencies: LimitPriceCheckDependencies = { fetchQuotes: (legs) => fetchLegQuoteSnapshots(ib, legs) },
): Promise<LimitPriceBlock | null> {
  const { legs } = orderRequest.payload;
  if (!legs || legs.length === 0) return null;

  let reason: string | null;
  try {
    const [tolerance, snapshot] = await Promise.all([loadPriceCheckTolerance(), dependencies.fetchQuotes(legs)]);
    const result = evaluateLimitPrices(
      legs.map((leg, index) => ({
        description: describeOrderLegForPriceCheck(leg),
        action: leg.action === "BUY" ? "BUY" : "SELL",
        limitPrice: leg.unitPrice,
        quote: snapshot.quotes[index] ?? null,
      })),
      tolerance,
    );
    reason = result.blocked ? describeLimitPriceRefusal(result, snapshot.notes) : null;
  } catch (error) {
    reason = `The order's limit price could not be checked against a live quote at placement (${error instanceof Error ? error.message : String(error)}).`;
  }
  if (!reason) return null;

  // Conditioned on still being confirmed, like the placement claim: a cancel that just landed keeps its own status.
  const endedRows = await db("order_requests")
    .where({ id: orderRequest.id, status: "confirmed" })
    .update({ status: "error", error_message: reason, updated_at: db.fn.now() })
    .returning("id");
  const ended = endedRows.length > 0;
  if (ended) await publishNotification({ type: "order_status", orderId: orderRequest.id }).catch(() => {});
  return { reason, ended };
}
