import type { GenosukeApiClient } from "./apiClient.js";
import type { PreparedConfirmation } from "./tools/types.js";
import { describeCommissionWarning, type OrderCommissionPreview } from "../lib/orderCommissionPreview.js";

// Genosuke's order card is built from the real order (approved 2026-10-05): the order is built first, the gate that
// confirm will run is read, and the card carries the same warnings the web order review shows. Any block means no
// card, no confirmable order left behind, and the reason goes back to the model to tell the human.

interface BuiltOrder {
  id: string;
  payload: { legs: unknown[] };
}

interface OrderGateSummary {
  blocks: string[];
  warnings: string[];
}

export interface PreparedOrder {
  orderId: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function prepareOrderConfirmation(api: GenosukeApiClient, buildPath: string, buildBody: unknown, baseCard: string): Promise<PreparedConfirmation> {
  let order: BuiltOrder;
  try {
    order = await api.post<BuiltOrder>(buildPath, buildBody);
  } catch (error) {
    return { problem: `The order could not be built, nothing was placed: ${messageOf(error)}` };
  }
  const discardOrder = () => api.post(`/positions/orders/${order.id}/cancel`, {}).catch(() => {});

  let gates: OrderGateSummary;
  try {
    gates = await api.get<OrderGateSummary>(`/positions/orders/${order.id}/gates`);
  } catch (error) {
    await discardOrder();
    return { problem: `The order could not be checked against the limits, so nothing was placed: ${messageOf(error)}` };
  }
  if (gates.blocks.length > 0) {
    await discardOrder();
    return { problem: `Blocked, nothing was placed: ${gates.blocks.join(" ")}` };
  }

  const warnings = [...gates.warnings];
  try {
    const preview = await api.post<OrderCommissionPreview>("/order-checks/commission-preview", { legs: order.payload.legs });
    const commissionWarning = describeCommissionWarning(preview);
    if (commissionWarning) warnings.push(commissionWarning);
  } catch {
    // The web form shows "commission unavailable" here and still lets the order through; the card does the same.
  }

  const description = warnings.length > 0 ? `${baseCard}\n\n⚠ Warnings:\n${warnings.map((warning) => `• ${warning}`).join("\n")}` : baseCard;
  return { description, prepared: { orderId: order.id } satisfies PreparedOrder };
}

/** Confirms the order that was built for the card; a failed confirm leaves nothing confirmable behind. */
export async function confirmPreparedOrder(api: GenosukeApiClient, prepared: PreparedOrder) {
  try {
    return await api.post<{ id: string; status: string }>(`/positions/orders/${prepared.orderId}/confirm`, {});
  } catch (error) {
    await api.post(`/positions/orders/${prepared.orderId}/cancel`, {}).catch(() => {});
    throw error;
  }
}

export async function discardPreparedOrder(prepared: unknown, api: GenosukeApiClient): Promise<void> {
  const orderId = (prepared as PreparedOrder | undefined)?.orderId;
  if (orderId) await api.post(`/positions/orders/${orderId}/cancel`, {});
}
