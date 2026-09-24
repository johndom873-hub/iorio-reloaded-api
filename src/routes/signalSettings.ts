import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { evaluateSignalOrderLimits } from "../lib/signalOrderLimits.js";
import { loadShortlistTicker } from "../lib/signalsStore.js";

export const signalSettingsRouter = Router();
signalSettingsRouter.use(requireAuth);

const settingsFields = [
  "max_delta_drift_pct",
  "min_annualized_yield_pct",
  "max_net_delta",
  "max_position_pct_of_portfolio",
  "max_concentration_per_ticker_pct",
  "min_cash_reserve_pct",
] as const;

function validateSettingsPayload(payload: Record<string, unknown>): string | null {
  for (const field of settingsFields) {
    const value = payload[field];
    if (typeof value !== "number" || Number.isNaN(value)) {
      return `${field} must be a number.`;
    }
  }
  const p = payload as Record<(typeof settingsFields)[number], number>;

  if (p.max_net_delta < 0 || p.max_net_delta > 1) return "max_net_delta must be between 0 and 1.";

  const percentageFields = [
    "max_delta_drift_pct",
    "min_annualized_yield_pct",
    "max_position_pct_of_portfolio",
    "max_concentration_per_ticker_pct",
    "min_cash_reserve_pct",
  ] as const;
  for (const field of percentageFields) {
    if (p[field] < 0 || p[field] > 100) return `${field} must be between 0 and 100.`;
  }

  return null;
}

signalSettingsRouter.get("/", async (_request, response) => {
  const row = await db("signal_settings as ss")
    .leftJoin("users as u", "u.id", "ss.updated_by_user_id")
    .select("ss.*", "u.display_name as updated_by_display_name")
    .first();
  response.json(row ?? null);
});

signalSettingsRouter.put("/", async (request, response) => {
  const validationError = validateSettingsPayload(request.body ?? {});
  if (validationError) {
    response.status(400).json({ error: validationError });
    return;
  }

  const body = request.body as Record<string, number>;
  const updatePayload: Record<string, number> = {};
  for (const field of settingsFields) {
    updatePayload[field] = body[field] as number;
  }

  const [row] = await db("signal_settings")
    .update({ ...updatePayload, updated_at: db.fn.now(), updated_by_user_id: request.session.userId })
    .returning("*");

  if (!row) {
    response.status(404).json({ error: "No signal_settings row found." });
    return;
  }
  response.json(row);
});

// Single shared evaluation of the three blocking limits (max position %,
// max concentration per ticker %, min cash reserve %) -- called by the
// Order Setup card as the user edits contract quantity (debounced), and
// reused as-is by the confirm-step hard gate and the order's live quote-
// stream compliance check (positions.ts). Approved 2026-09-24.
signalSettingsRouter.get("/order-limits-check", async (request, response) => {
  const { symbol, strategyKey, quantity, strike, spotPrice } = request.query;
  if (typeof symbol !== "string" || !symbol.trim()) {
    response.status(400).json({ error: "symbol is required." });
    return;
  }
  if (strategyKey !== "covered_call" && strategyKey !== "cash_secured_put") {
    response.status(400).json({ error: "strategyKey must be covered_call or cash_secured_put." });
    return;
  }
  const parsedQuantity = Number(quantity);
  const parsedStrike = Number(strike);
  if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
    response.status(400).json({ error: "quantity must be a positive number." });
    return;
  }
  if (!Number.isFinite(parsedStrike) || parsedStrike <= 0) {
    response.status(400).json({ error: "strike must be a positive number." });
    return;
  }

  const ticker = await loadShortlistTicker(symbol);
  if (!ticker) {
    response.status(400).json({ error: "Unknown symbol — add it via the Shortlist first." });
    return;
  }

  // spotPrice is optional: the frontend already has a live spot for the modal it's calling from,
  // so passing it avoids an extra IBKR round trip on every debounced keystroke. Omitted, it's fetched fresh.
  const parsedSpotPrice = spotPrice === undefined ? undefined : Number(spotPrice);
  if (parsedSpotPrice !== undefined && (!Number.isFinite(parsedSpotPrice) || parsedSpotPrice <= 0)) {
    response.status(400).json({ error: "spotPrice must be a positive number." });
    return;
  }

  const result = await evaluateSignalOrderLimits({
    strategyKey,
    symbol: ticker.symbol,
    tickerId: ticker.tickerId,
    quantity: parsedQuantity,
    strike: parsedStrike,
    spotPrice: parsedSpotPrice,
  });
  response.json(result);
});
