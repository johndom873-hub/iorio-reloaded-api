import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { evaluateSignalOrderLimits } from "../lib/signalOrderLimits.js";
import { loadTickerBySymbol } from "../lib/signalsChainStore.js";
import { OrderAction } from "@stoqey/ib";
import { findMalformedOptionExpiry, type OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { fetchWhatIfCommissionRange } from "../ibkr/ibkrWhatIfCommission.js";
import { loadCommissionEstimator } from "../lib/commissionEstimate.js";
import { buildOrderCommissionPreview } from "../lib/orderCommissionPreview.js";
import { loadSignalSettings } from "../lib/signalSettingsStore.js";

export const signalSettingsRouter = Router();
signalSettingsRouter.use(requireAuth);

const settingsFields = [
  "max_delta_drift_pct",
  "min_annualized_yield_pct",
  "max_net_delta",
  "max_position_pct_of_portfolio",
  "max_concentration_per_ticker_pct",
  "min_cash_reserve_pct",
  "commission_warn_share_of_premium_pct",
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
    "commission_warn_share_of_premium_pct",
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
  const { symbol, strategyKey, quantity, strike, spotPrice, rollFromStrike } = request.query;
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

  // Any known ticker: a contract picked from the full chain can be on a ticker outside the Signals universe (a stock-only position).
  const ticker = await loadTickerBySymbol(symbol);
  if (!ticker) {
    response.status(400).json({ error: "Unknown symbol." });
    return;
  }

  // spotPrice is optional: the frontend already has a live spot for the modal it's calling from,
  // so passing it avoids an extra IBKR round trip on every debounced keystroke. Omitted, it's fetched fresh.
  const parsedSpotPrice = spotPrice === undefined ? undefined : Number(spotPrice);
  if (parsedSpotPrice !== undefined && (!Number.isFinite(parsedSpotPrice) || parsedSpotPrice <= 0)) {
    response.status(400).json({ error: "spotPrice must be a positive number." });
    return;
  }

  // rollFromStrike marks a roll (Roll Signals): the order only adds the strike difference's notional, see signalOrderLimits.ts.
  const parsedRollFromStrike = rollFromStrike === undefined ? undefined : Number(rollFromStrike);
  if (parsedRollFromStrike !== undefined && (!Number.isFinite(parsedRollFromStrike) || parsedRollFromStrike <= 0)) {
    response.status(400).json({ error: "rollFromStrike must be a positive number." });
    return;
  }

  const result = await evaluateSignalOrderLimits({
    strategyKey,
    symbol: ticker.symbol,
    tickerId: ticker.tickerId,
    quantity: parsedQuantity,
    strike: parsedStrike,
    spotPrice: parsedSpotPrice,
    rollFromStrike: parsedRollFromStrike,
  });
  response.json(result);
});

const maxPreviewLegs = 4;

/** The legs of an order about to be set up, or the reason they are unusable. Never trusts the body's shape. */
function parseCommissionPreviewLegs(body: unknown): { legs: OrderLegPayload[] } | { error: string } {
  const rawLegs = (body as { legs?: unknown } | null)?.legs;
  if (!Array.isArray(rawLegs) || rawLegs.length === 0 || rawLegs.length > maxPreviewLegs) return { error: `legs must be a list of 1 to ${maxPreviewLegs} legs.` };
  const legs: OrderLegPayload[] = [];
  for (const raw of rawLegs as Record<string, unknown>[]) {
    const { role, action, symbol, quantity, unitPrice, strike, expiry, right } = raw ?? {};
    if (role !== "stock" && role !== "option") return { error: "Each leg needs role stock or option." };
    if (action !== OrderAction.BUY && action !== OrderAction.SELL) return { error: "Each leg needs action BUY or SELL." };
    if (typeof symbol !== "string" || !symbol.trim()) return { error: "Each leg needs a symbol." };
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) return { error: "Each leg needs a positive whole quantity." };
    if (typeof unitPrice !== "number" || !(unitPrice > 0)) return { error: "Each leg needs a positive unitPrice." };
    if (role === "option") {
      if (typeof strike !== "number" || !(strike > 0)) return { error: "Each option leg needs a positive strike." };
      if (right !== "C" && right !== "P") return { error: "Each option leg needs right C or P." };
    }
    legs.push({ role, action, symbol: symbol.trim().toUpperCase(), quantity, unitPrice, ...(role === "option" ? { strike: strike as number, expiry: expiry as string, right: right as "C" | "P" } : {}) });
  }
  const malformedExpiry = findMalformedOptionExpiry(legs);
  if (malformedExpiry) return { error: malformedExpiry };
  if (new Set(legs.map((leg) => leg.symbol)).size > 1) return { error: "All legs must be on the same symbol." };
  return { legs };
}

// Commission shown in the order setup (approved 2026-10-02): IBKR's what-if for this exact order, the
// trailing-fills estimate when IBKR cannot answer. Called once per setup form and again only when its
// quantity or fill priority changes -- never per Signals row. Read-only: the what-if order is never worked.
signalSettingsRouter.post("/commission-preview", async (request, response) => {
  const parsed = parseCommissionPreviewLegs(request.body);
  if ("error" in parsed) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  const ticker = await loadTickerBySymbol(parsed.legs[0]!.symbol);
  if (!ticker) {
    response.status(400).json({ error: "Unknown symbol." });
    return;
  }
  const [settings, estimator, whatIf] = await Promise.all([
    loadSignalSettings(),
    loadCommissionEstimator(),
    fetchWhatIfCommissionRange(parsed.legs).then(
      (range) => ({ range, failureReason: null }),
      (error: unknown) => ({ range: null, failureReason: error instanceof Error ? error.message : String(error) }),
    ),
  ]);
  response.json(
    buildOrderCommissionPreview({
      legs: parsed.legs,
      whatIfCommission: whatIf.range,
      whatIfFailureReason: whatIf.failureReason,
      estimator,
      warnThresholdPct: settings.commissionWarnSharePctOfPremium,
    }),
  );
});
