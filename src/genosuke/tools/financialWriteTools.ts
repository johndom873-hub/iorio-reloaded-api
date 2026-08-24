// Financial-consequence write tools — every one of these has a real effect
// on the trading record (a position gets created/rolled/closed, an alert
// gets rejected, risk settings that govern future trade generation change).
// None of these execute on the model's say-so alone: the bot loop (see
// bot.ts) intercepts any call to a tool in this tier, sends a Telegram
// inline Yes/Cancel confirmation built from describeForConfirmation(), and
// only invokes execute() if the human taps Yes. This is a deliberate
// departure from Jack (menaris-admin-api), whose only mutating tools (WAF
// rules) rely purely on a system-prompt instruction to ask before acting —
// approved 2026-08-21 as too weak a guarantee for real trading data.
//
// Since 2026-08-24, iorio places REAL orders against IBKR (still the paper
// account) — see PROGRESS.md's "IBKR is the source of truth" decision. The
// old claim here ("blast radius of a mistake is a bad database record, not
// an actual fill") is no longer true: create_position/roll_position/
// close_position now build an order via POST /positions/orders (or
// /:id/roll, /:id/close) and immediately confirm it via
// POST /positions/orders/:id/confirm, which transmits the order to IBKR.
// The Telegram Yes/Cancel tap IS the human confirmation gate for that
// transmit step — there's no second in-app confirmation for the bot path,
// unlike the web UI's OrderReviewPanel (which shows the built order and
// waits for an explicit Confirm click before calling the same endpoint).
import type { GenosukeApiClient } from "../apiClient.js";
import type { GenosukeTool } from "./types.js";

const strategyKeyEnum = { type: "string", enum: ["covered_call", "cash_secured_put"] };

interface OrderRequestResult {
  id: string;
  status: string;
}

async function buildAndConfirmOrder(api: GenosukeApiClient, path: string, body: unknown) {
  const order = await api.post<OrderRequestResult>(path, body);
  return api.post<OrderRequestResult>(`/positions/orders/${order.id}/confirm`, {});
}

export const financialWriteTools: GenosukeTool[] = [
  {
    name: "create_position",
    description:
      "Open a new position by placing a real order with IBKR — either approving a pending Trade Alert (pass sourceAlertId; strongly preferred when one exists, since the alert's suggested strike/expiry/premium is already validated against the live option chain) or a fully manual entry (higher risk of a typo'd strike/price — the human confirmation step is the safety net here). Builds and immediately confirms the order — nothing further is needed after the human taps Yes.",
    tier: "financial-write",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        strategyKey: strategyKeyEnum,
        stock: {
          type: "object",
          description: "Required for covered_call. Buy-write stock leg.",
          properties: { quantity: { type: "number" }, limitPrice: { type: "number" } },
          required: ["quantity", "limitPrice"],
        },
        option: {
          type: "object",
          description: "The short call (covered_call) or short put (cash_secured_put) leg.",
          properties: {
            quantity: { type: "number", description: "Contracts." },
            limitPrice: { type: "number" },
            strikePrice: { type: "number" },
            expiryDate: { type: "string", description: "YYYYMMDD." },
          },
          required: ["quantity", "limitPrice", "strikePrice", "expiryDate"],
        },
        notes: { type: "string" },
        priceTarget: { type: "number" },
        sourceAlertId: { type: "string", description: "If approving a pending Trade Alert, its id — links the alert and marks it approved." },
      },
      required: ["symbol", "strategyKey", "option"],
    },
    describeForConfirmation: (input) => {
      const option = input.option as { quantity: unknown; strikePrice: unknown; expiryDate: unknown; limitPrice: unknown };
      const stock = input.stock as { quantity: unknown; limitPrice: unknown } | undefined;
      const stockPart = stock ? `BUY ${stock.quantity} sh @ ${stock.limitPrice} + ` : "";
      return `Place order for ${input.symbol} (${input.strategyKey}): ${stockPart}SELL ${option.quantity}x $${option.strikePrice} exp ${option.expiryDate} @ ${option.limitPrice}${input.sourceAlertId ? " (approving pending alert)" : " (manual entry)"} — will be sent to IBKR immediately on confirm.`;
    },
    tracksOrderStatus: true,
    execute: (input, api) => buildAndConfirmOrder(api, "/positions/orders", input),
  },
  {
    name: "roll_position",
    description:
      "Roll one short option leg on an open position by placing a real atomic combo order with IBKR (buy back the existing leg, sell the new one, in one order) — tied to a pending roll-type Trade Alert. Only valid for a pending alert of alertType 'roll' — get its details from list_trade_alerts/get_position first. Builds and immediately confirms the order.",
    tier: "financial-write",
    parameters: {
      type: "object",
      properties: {
        positionId: { type: "string" },
        sourceAlertId: { type: "string" },
        closeLegId: { type: "string", description: "The existing option leg being closed." },
        closeLimitPrice: { type: "number", description: "Max price willing to pay to buy back the closing leg." },
        newLeg: {
          type: "object",
          properties: {
            strikePrice: { type: "number" },
            expiryDate: { type: "string" },
            quantity: { type: "number" },
            limitPrice: { type: "number", description: "Min premium willing to accept for the new leg." },
          },
          required: ["strikePrice", "expiryDate", "quantity", "limitPrice"],
        },
      },
      required: ["positionId", "sourceAlertId", "closeLegId", "closeLimitPrice", "newLeg"],
    },
    describeForConfirmation: (input) => {
      const newLeg = input.newLeg as { strikePrice: unknown; expiryDate: unknown; limitPrice: unknown };
      return `Roll position ${input.positionId}: buy back closing leg @ ${input.closeLimitPrice}, sell new leg $${newLeg.strikePrice} exp ${newLeg.expiryDate} @ ${newLeg.limitPrice} — one atomic combo order sent to IBKR immediately on confirm.`;
    },
    tracksOrderStatus: true,
    execute: (input, api) => {
      const { positionId, ...body } = input;
      return buildAndConfirmOrder(api, `/positions/${positionId}/roll`, body);
    },
  },
  {
    name: "close_position",
    description:
      "Close a position by placing a real combo order with IBKR — every currently-open leg must be included together with a limit price (partial-leg closes aren't supported). Builds and immediately confirms the order.",
    tier: "financial-write",
    parameters: {
      type: "object",
      properties: {
        positionId: { type: "string" },
        legs: {
          type: "array",
          items: {
            type: "object",
            properties: { legId: { type: "string" }, limitPrice: { type: "number" } },
            required: ["legId", "limitPrice"],
          },
        },
      },
      required: ["positionId", "legs"],
    },
    describeForConfirmation: (input) => {
      const legs = (input.legs as { legId: string; limitPrice: unknown }[]) ?? [];
      return `Close position ${input.positionId}: ${legs.map((l) => `leg ${l.legId} @ ${l.limitPrice}`).join(", ")} — combo order sent to IBKR immediately on confirm.`;
    },
    tracksOrderStatus: true,
    execute: (input, api) => {
      const { positionId, legs } = input;
      return buildAndConfirmOrder(api, `/positions/${positionId}/close`, { legs });
    },
  },
  {
    name: "reject_trade_alert",
    description: "Reject a pending Trade Alert. This is the only status change this tool supports — approving happens via create_position/roll_position with sourceAlertId instead, so the actual order terms are always confirmed first.",
    tier: "financial-write",
    parameters: { type: "object", properties: { alertId: { type: "string" } }, required: ["alertId"] },
    describeForConfirmation: (input) => `Reject trade alert ${input.alertId}`,
    execute: (input, api) => api.patch(`/trade-alerts/${input.alertId}`, { status: "rejected" }),
  },
  {
    name: "update_risk_limits",
    description: "Update a strategy's risk settings (delta/DTE targets, position/collateral/concentration caps, minimum cash reserve). Governs future Trade Alert generation, not existing positions.",
    tier: "financial-write",
    parameters: {
      type: "object",
      properties: {
        strategyKey: strategyKeyEnum,
        delta_target_min: { type: "number" },
        delta_target_max: { type: "number" },
        dte_target_min: { type: "number" },
        dte_target_max: { type: "number" },
        max_position_pct_of_portfolio: { type: "number" },
        max_aggregate_collateral_pct: { type: "number" },
        max_concentration_per_ticker_pct: { type: "number" },
        max_concentration_per_sector_pct: { type: "number" },
        min_cash_reserve_pct: { type: "number" },
      },
      required: [
        "strategyKey",
        "delta_target_min",
        "delta_target_max",
        "dte_target_min",
        "dte_target_max",
        "max_position_pct_of_portfolio",
        "max_aggregate_collateral_pct",
        "max_concentration_per_ticker_pct",
        "max_concentration_per_sector_pct",
        "min_cash_reserve_pct",
      ],
    },
    describeForConfirmation: (input) => `Update ${input.strategyKey} risk settings: delta ${input.delta_target_min}-${input.delta_target_max}, DTE ${input.dte_target_min}-${input.dte_target_max}, and 5 other fields`,
    execute: (input, api) => {
      const { strategyKey, ...settings } = input;
      return api.put(`/risk-limits/settings/${strategyKey}`, settings);
    },
  },
];
