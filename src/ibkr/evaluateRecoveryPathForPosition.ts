import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { lookupPricingSnapshot } from "./fetchTickerOverview.js";
import { generateTradeAlertCandidates, type AlertCandidate } from "./generateTradeAlertCandidates.js";
import { toSettings } from "./runTradeAlertGeneration.js";

const SHARES_PER_CONTRACT = 100;

export type RecoveryPathEvaluation =
  | { status: "not_found" }
  | { status: "not_unstructured"; reason: string }
  | { status: "no_shares" }
  | { status: "no_settings" }
  | {
      status: "ok";
      symbol: string;
      shares: number;
      entryPrice: number;
      currentPrice: number;
      unrealizedLoss: number;
      contractsAvailable: number;
      candidate: AlertCandidate | null;
      monthlyPremium: number | null;
      monthsToRecover: number | null;
      rationale: string;
    };

/**
 * On-demand recovery-path projection for an unstructured bare-stock
 * position (leftover from an expired covered call or an assigned CSP) --
 * "Recovery Path Formula" proposal, approved by Marcelo 2026-08-31:
 *   unrealized loss = max(0, entry price − current price) × shares
 *   monthly premium = top-ranked live covered-call candidate's premium × 100 × contracts available
 *   months to recover = ceil(unrealized loss ÷ monthly premium)
 * Reuses generateTradeAlertCandidates (same delta/DTE window already
 * configured for covered_call) rather than a separate recommendation
 * engine, per the approved proposal. Read-only, writes nothing — same
 * pattern as evaluateRollForPosition.ts. Opens its own short-lived IBKR
 * connection.
 */
export async function evaluateRecoveryPathForPosition(positionId: string): Promise<RecoveryPathEvaluation> {
  const positionRow = await db("positions as p")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where({ "p.id": positionId })
    .select("p.id", "p.status", "p.strategy_key as strategyKey", "t.id as tickerId", "t.symbol")
    .first();

  if (!positionRow) return { status: "not_found" };
  if (positionRow.status !== "open" || positionRow.strategyKey !== "unstructured") {
    return { status: "not_unstructured", reason: "Only an open unstructured position can be evaluated for recovery." };
  }

  const legs: { quantity: string; entryPrice: string }[] = await db("position_legs")
    .where({ position_id: positionId, leg_type: "stock", side: "long" })
    .whereNull("exit_at")
    .select("quantity", "entry_price as entryPrice");

  const shares = legs.reduce((sum, leg) => sum + Number(leg.quantity), 0);
  if (shares <= 0) return { status: "no_shares" };
  const entryPrice = legs.reduce((sum, leg) => sum + Number(leg.quantity) * Number(leg.entryPrice), 0) / shares;

  const settingsRow = await db("strategy_settings").where({ strategy_key: "covered_call" }).first();
  if (!settingsRow) return { status: "no_settings" };
  const settings = toSettings(settingsRow);

  const connection = await connectToIbkrGateway();
  requestRealtimeMarketData(connection.ib);
  try {
    const pricing = await lookupPricingSnapshot(connection, positionRow.symbol);
    const currentPrice = pricing.last ?? pricing.previousClose;
    if (currentPrice === null) throw new Error(`No current price available for ${positionRow.symbol}`);

    const contractsAvailable = Math.floor(shares / SHARES_PER_CONTRACT);
    const candidates =
      contractsAvailable >= 1
        ? await generateTradeAlertCandidates(connection, positionRow.symbol, positionRow.tickerId, "covered_call", settings)
        : [];
    const candidate = candidates[0] ?? null;

    const unrealizedLoss = Math.max(0, entryPrice - currentPrice) * shares;
    const monthlyPremium = candidate ? candidate.premium * SHARES_PER_CONTRACT * contractsAvailable : null;
    const monthsToRecover = monthlyPremium !== null && monthlyPremium > 0 ? Math.ceil(unrealizedLoss / monthlyPremium) : null;

    const rationale =
      contractsAvailable < 1
        ? `Only ${shares} share(s) held — need at least ${SHARES_PER_CONTRACT} to write a covered call.`
        : candidate
          ? `Sell ${contractsAvailable}x $${candidate.strike} call exp ${candidate.expiry} for $${candidate.premium.toFixed(2)} premium.`
          : `No covered-call candidate currently fits the configured delta/DTE window for ${positionRow.symbol}.`;

    return {
      status: "ok",
      symbol: positionRow.symbol,
      shares,
      entryPrice,
      currentPrice,
      unrealizedLoss,
      contractsAvailable,
      candidate,
      monthlyPremium,
      monthsToRecover,
      rationale,
    };
  } finally {
    connection.disconnect();
  }
}
