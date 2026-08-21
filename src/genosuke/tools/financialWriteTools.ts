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
// iorio never places a live broker order anywhere in the app — every write
// below is a manually-recorded fill in Postgres, not an IBKR order
// execution (see PROGRESS.md's Genosuke entry). Still real — it's what a
// human trader acts on — but the blast radius of a mistake is a bad
// database record, not an actual fill.
import type { GenosukeTool } from "./types.js";

const strategyKeyEnum = { type: "string", enum: ["covered_call", "cash_secured_put"] };

const legInputSchema = {
  type: "object",
  properties: {
    legType: { type: "string", enum: ["stock", "option"] },
    side: { type: "string", enum: ["long", "short"] },
    quantity: { type: "number" },
    optionType: { type: "string", enum: ["call", "put"], description: "Required if legType is option." },
    strikePrice: { type: "number", description: "Required if legType is option." },
    expiryDate: { type: "string", description: "YYYY-MM-DD, required if legType is option." },
    multiplier: { type: "number", description: "Shares per contract — 100 for standard options, 1 for stock." },
    entryPrice: { type: "number" },
    entryAt: { type: "string", description: "ISO timestamp of the actual fill." },
  },
  required: ["legType", "side", "quantity", "multiplier", "entryPrice", "entryAt"],
};

function legSummary(leg: { legType: string; side: string; quantity: unknown; strikePrice?: unknown; optionType?: unknown }): string {
  if (leg.legType === "stock") return `${leg.side} ${leg.quantity} sh`;
  const right = leg.optionType === "call" ? "C" : "P";
  return `${leg.side} ${leg.quantity}x $${leg.strikePrice}${right}`;
}

export const financialWriteTools: GenosukeTool[] = [
  {
    name: "create_position",
    description:
      "Create a new position — either approving a pending Trade Alert (pass sourceAlertId; strongly preferred when one exists, since the alert's suggested strike/expiry/premium is already validated against the live option chain) or a fully manual entry (freeform legs, higher risk of a typo'd strike/price — the human confirmation step is the safety net here).",
    tier: "financial-write",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        strategyKey: strategyKeyEnum,
        notes: { type: "string" },
        priceTarget: { type: "number" },
        legs: { type: "array", items: legInputSchema, description: "1 leg for a CSP (short put), 2 legs for a covered call (long stock + short call)." },
        sourceAlertId: { type: "string", description: "If approving a pending Trade Alert, its id — links the alert and marks it approved." },
      },
      required: ["symbol", "strategyKey", "legs"],
    },
    describeForConfirmation: (input) => {
      const legs = (input.legs as { legType: string; side: string; quantity: unknown; strikePrice?: unknown; optionType?: unknown }[]) ?? [];
      return `Create ${input.strategyKey} position on ${input.symbol}: ${legs.map(legSummary).join(" / ")}${input.sourceAlertId ? " (approving pending alert)" : " (manual entry)"}`;
    },
    execute: (input, api) => api.post("/positions", input),
  },
  {
    name: "roll_position",
    description:
      "Roll one short option leg on an open position: closes the existing leg at a given exit price and opens a new leg at a new strike/expiry, both tied to a pending roll-type Trade Alert. Only valid for a pending alert of alertType 'roll' — get its details from list_trade_alerts/get_position first.",
    tier: "financial-write",
    parameters: {
      type: "object",
      properties: {
        positionId: { type: "string" },
        sourceAlertId: { type: "string" },
        closeLegId: { type: "string", description: "The existing option leg being closed." },
        exitPrice: { type: "number", description: "Buy-back price for the closing leg." },
        exitAt: { type: "string", description: "ISO timestamp of the actual fill." },
        newLeg: {
          type: "object",
          properties: {
            strikePrice: { type: "number" },
            expiryDate: { type: "string" },
            quantity: { type: "number" },
            multiplier: { type: "number" },
            entryPrice: { type: "number", description: "Premium received for the new leg." },
            entryAt: { type: "string" },
          },
          required: ["strikePrice", "expiryDate", "quantity", "multiplier", "entryPrice", "entryAt"],
        },
      },
      required: ["positionId", "sourceAlertId", "closeLegId", "exitPrice", "exitAt", "newLeg"],
    },
    describeForConfirmation: (input) => {
      const newLeg = input.newLeg as { strikePrice: unknown; expiryDate: unknown; entryPrice: unknown };
      return `Roll position ${input.positionId}: buy back closing leg at $${input.exitPrice}, open new leg at $${newLeg.strikePrice} exp ${newLeg.expiryDate} for $${newLeg.entryPrice} premium`;
    },
    execute: (input, api) => {
      const { positionId, ...body } = input;
      return api.post(`/positions/${positionId}/roll`, body);
    },
  },
  {
    name: "close_position",
    description: "Close a position — every leg must be closed together with its exit price and time (partial-leg closes aren't supported).",
    tier: "financial-write",
    parameters: {
      type: "object",
      properties: {
        positionId: { type: "string" },
        legs: {
          type: "array",
          items: {
            type: "object",
            properties: { legId: { type: "string" }, exitPrice: { type: "number" }, exitAt: { type: "string" } },
            required: ["legId", "exitPrice", "exitAt"],
          },
        },
      },
      required: ["positionId", "legs"],
    },
    describeForConfirmation: (input) => {
      const legs = (input.legs as { legId: string; exitPrice: unknown }[]) ?? [];
      return `Close position ${input.positionId}: ${legs.map((l) => `leg ${l.legId} at $${l.exitPrice}`).join(", ")}`;
    },
    execute: (input, api) => {
      const { positionId, legs } = input;
      return api.post(`/positions/${positionId}/close`, { legs });
    },
  },
  {
    name: "reject_trade_alert",
    description: "Reject a pending Trade Alert. This is the only status change this tool supports — approving happens via create_position/roll_position with sourceAlertId instead, so the actual fill price is always confirmed first.",
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
