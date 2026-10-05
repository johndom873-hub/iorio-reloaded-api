import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { evaluateOrderLimits } from "../lib/orderLimits.js";
import { loadTickerBySymbol } from "../lib/signalsChainStore.js";
import { OrderAction } from "@stoqey/ib";
import { findMalformedOptionExpiry, type OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { fetchWhatIfCommissionRange } from "../ibkr/ibkrWhatIfCommission.js";
import { loadCommissionEstimator } from "../lib/commissionEstimate.js";
import { buildOrderCommissionPreview } from "../lib/orderCommissionPreview.js";
import { loadTradingSettings } from "../lib/tradingSettingsStore.js";

// Order-time checks used by the order setup forms: the position limits and the commission preview.
// Both run for any order (Signals, the chain, the position form); the limits are the single set in trading_settings.
export const orderChecksRouter = Router();
orderChecksRouter.use(requireAuth);

// Single shared evaluation of the three blocking limits (max position %,
// max concentration per ticker %, min cash reserve %) -- called by the
// Order Setup card as the user edits contract quantity (debounced), and
// reused as-is by the confirm-step hard gate and the order's live quote-
// stream compliance check (positions.ts). Approved 2026-09-24.
orderChecksRouter.get("/limits", async (request, response) => {
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
  if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
    response.status(400).json({ error: "quantity must be a positive whole number of contracts." });
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

  // rollFromStrike marks a roll (Roll Signals): the order only adds the strike difference's notional, see orderLimits.ts.
  const parsedRollFromStrike = rollFromStrike === undefined ? undefined : Number(rollFromStrike);
  if (parsedRollFromStrike !== undefined && (!Number.isFinite(parsedRollFromStrike) || parsedRollFromStrike <= 0)) {
    response.status(400).json({ error: "rollFromStrike must be a positive number." });
    return;
  }

  const result = await evaluateOrderLimits({
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
orderChecksRouter.post("/commission-preview", async (request, response) => {
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
    loadTradingSettings(),
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
