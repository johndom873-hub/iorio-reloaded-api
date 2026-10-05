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
import { tradingSettingsColumns } from "../../lib/tradingSettingsStore.js";
import { confirmPreparedOrder, discardPreparedOrder, prepareOrderConfirmation, type PreparedOrder } from "../prepareOrderConfirmation.js";
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

function buildOpenOrderCard(input: Record<string, unknown>): string {
  const option = input.option as { quantity: unknown; strikePrice: unknown; expiryDate: unknown; limitPrice: unknown };
  const stock = input.stock as { quantity: unknown; limitPrice: unknown } | undefined;
  const stockPart = stock ? `BUY ${stock.quantity} sh @ ${stock.limitPrice} + ` : "";
  return `Place order for ${input.symbol} (${input.strategyKey}): ${stockPart}SELL ${option.quantity}x $${option.strikePrice} exp ${option.expiryDate} @ ${option.limitPrice} — will be sent to IBKR immediately on confirm.`;
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
    prepareConfirmation: (input, api) => prepareOrderConfirmation(api, "/positions/orders", input, buildOpenOrderCard(input)),
    discardPrepared: discardPreparedOrder,
    tracksOrderStatus: true,
    execute: (input, api, prepared) => (prepared ? confirmPreparedOrder(api, prepared as PreparedOrder) : buildAndConfirmOrder(api, "/positions/orders", input)),
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
    prepareConfirmation: async (input, api) => {
      const position = await fetchPositionForCard(api, input.positionId);
      const legs = (input.legs as { legId: string; limitPrice: unknown }[]) ?? [];
      const problem = validateCloseLegs(position, legs);
      if (problem) return { problem };
      return prepareOrderConfirmation(api, `/positions/${input.positionId}/close`, { legs: input.legs }, buildCloseCard(position, legs));
    },
    discardPrepared: discardPreparedOrder,
    tracksOrderStatus: true,
    execute: (input, api, prepared) => {
      if (prepared) return confirmPreparedOrder(api, prepared as PreparedOrder);
      const { positionId, legs } = input;
      return buildAndConfirmOrder(api, `/positions/${positionId}/close`, { legs });
    },
  },
  {
    name: "update_risk_limits",
    description:
      "Change the trading limits and targets (one set for every strategy): max position %, max concentration per ticker %, min cash reserve % (these block orders), the delta band (blocks new orders outside it, filters Signals and the recovery-path suggestion), the Recovery Path DTE window, min annualized yield % (Signals filter) and the commission warning %. Send only the fields to change; the rest keep their current values. Does not change existing positions.",
    tier: "financial-write",
    parameters: {
      type: "object",
      properties: {
        maxPositionPctOfPortfolio: { type: "number" },
        maxConcentrationPerTickerPct: { type: "number" },
        minCashReservePct: { type: "number" },
        deltaTargetMin: { type: "number" },
        deltaTargetMax: { type: "number" },
        recoveryDteMin: { type: "number" },
        recoveryDteMax: { type: "number" },
        minAnnualizedYieldPct: { type: "number" },
        commissionWarnSharePctOfPremium: { type: "number" },
      },
    },
    validateBeforeConfirmation: async (input) => {
      const unknownSettings = Object.keys(input).filter((name) => !(name in tradingSettingsColumns));
      if (unknownSettings.length > 0) return `Unknown setting(s): ${unknownSettings.join(", ")}. Valid settings: ${Object.keys(tradingSettingsColumns).join(", ")}.`;
      return Object.keys(input).length === 0 ? "Send at least one setting to change." : null;
    },
    describeForConfirmation: async (input, api) => buildRiskLimitsCard(input, await api.get<Record<string, unknown>>("/risk-limits/settings")),
    execute: async (input, api) => {
      // The route validates a complete set, so the unchanged fields are filled in from the current settings.
      const { updatedAt: _updatedAt, updatedByDisplayName: _updatedBy, ...current } = await api.get<Record<string, unknown>>("/risk-limits/settings");
      return api.put("/risk-limits/settings", { ...current, ...input });
    },
  },
];
