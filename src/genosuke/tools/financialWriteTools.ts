// Financial-consequence write tools — every one of these has a real effect
// on the trading record (a position gets created/closed, risk settings
// change).
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
// an actual fill") is no longer true: create_position/close_position now
// build an order via POST /positions/orders (or /:id/close) and
// immediately confirm it via
// POST /positions/orders/:id/confirm, which transmits the order to IBKR.
// The Telegram Yes/Cancel tap IS the human confirmation gate for that
// transmit step — there's no second in-app confirmation for the bot path,
// unlike the web UI's OrderReviewPanel (which shows the built order and
// waits for an explicit Confirm click before calling the same endpoint).
import type { GenosukeApiClient } from "../apiClient.js";
import type { GenosukeTool } from "./types.js";
import {
  buildCloseCard,
  buildRiskLimitsCard,
  validateCloseLegs,
  type PositionForCard,
} from "../confirmationText.js";

const fetchPositionForCard = (api: GenosukeApiClient, positionId: unknown) => api.get<PositionForCard>(`/positions/${positionId}`);

const strategyKeyEnum = { type: "string", enum: ["covered_call", "cash_secured_put"] };

interface OrderRequestResult {
  id: string;
  status: string;
}

async function buildAndConfirmOrder(api: GenosukeApiClient, path: string, body: unknown) {
  const order = await api.post<OrderRequestResult>(path, body);
  try {
    return await api.post<OrderRequestResult>(`/positions/orders/${order.id}/confirm`, {});
  } catch (error) {
    // A failed confirm (trading blocked, limits, stale) must not leave a
    // confirmable order behind — see stalePendingOrders.ts.
    await api.post(`/positions/orders/${order.id}/cancel`, {}).catch(() => {});
    throw error;
  }
}

export const financialWriteTools: GenosukeTool[] = [
  {
    name: "create_position",
    description:
      "Open a new position by placing a real order with IBKR (the human confirmation step is the safety net against a typo'd strike/price). Builds and immediately confirms the order — nothing further is needed after the human taps Yes.",
    tier: "financial-write",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        strategyKey: strategyKeyEnum,
        stock: {
          type: "object",
          description:
            "Buy-write stock leg — used for covered_call only. For cash_secured_put, omit this field entirely (do not pass it with zeros or placeholder values — cash_secured_put never has a stock leg, and the server ignores this field for that strategy regardless). For covered_call, never ask the human how many shares or what stock price to use: compute quantity yourself as option.quantity * 100 and limitPrice as the current stock price (from get_ticker_quote, rounded to the nearest cent) — pass it here so the human sees the real stock leg on the Yes/Cancel confirmation before it's sent to IBKR. If omitted, the server will auto-fill the same 100-shares-per-contract default using its own live quote, but the human then won't see the stock leg in the confirmation text, so only rely on that fallback if no price source is available. Only ask the human explicitly if they want deliberate over-coverage (more shares than the calls need) or a stock limit different from market.",
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
      },
      required: ["symbol", "strategyKey", "option"],
    },
    describeForConfirmation: (input) => {
      const option = input.option as { quantity: unknown; strikePrice: unknown; expiryDate: unknown; limitPrice: unknown };
      const stock = input.stock as { quantity: unknown; limitPrice: unknown } | undefined;
      const stockPart = stock ? `BUY ${stock.quantity} sh @ ${stock.limitPrice} + ` : "";
      return `Place order for ${input.symbol} (${input.strategyKey}): ${stockPart}SELL ${option.quantity}x $${option.strikePrice} exp ${option.expiryDate} @ ${option.limitPrice} — will be sent to IBKR immediately on confirm.`;
    },
    tracksOrderStatus: true,
    execute: (input, api) => buildAndConfirmOrder(api, "/positions/orders", input),
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
    validateBeforeConfirmation: async (input, api) =>
      validateCloseLegs(await fetchPositionForCard(api, input.positionId), (input.legs as { legId: string }[]) ?? []),
    describeForConfirmation: async (input, api) =>
      buildCloseCard(await fetchPositionForCard(api, input.positionId), (input.legs as { legId: string; limitPrice: unknown }[]) ?? []),
    tracksOrderStatus: true,
    execute: (input, api) => {
      const { positionId, legs } = input;
      return buildAndConfirmOrder(api, `/positions/${positionId}/close`, { legs });
    },
  },
  {
    name: "update_risk_limits",
    description: "Update a strategy's risk settings (delta/DTE targets, position/collateral/concentration caps, minimum cash reserve). Governs the delta check on new orders and the recovery-path suggestion, not existing positions.",
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
    describeForConfirmation: (input) => buildRiskLimitsCard(input),
    execute: (input, api) => {
      const { strategyKey, ...settings } = input;
      return api.put(`/risk-limits/settings/${strategyKey}`, settings);
    },
  },
];
