import { MarketDataType } from "@stoqey/ib";
import { getBestKnownStockPrice } from "../lib/priceService.js";
import { db } from "../db/connection.js";
import { borrowSharedConnectionOrConnect, nextReqIdFor, sharedReadConnection } from "./sharedReadConnection.js";
import { lookupPricingSnapshot } from "./fetchTickerOverview.js";
import { loadRecoveryTargetWindow } from "../lib/recoveryTargetWindow.js";
import { scanRecoveryPathCoveredCallCandidates, type CoveredCallCandidate } from "./scanRecoveryPathCoveredCallCandidates.js";
import { fetchBreakEvenByPositionId } from "../lib/cycleBreakEvenQueries.js";

const SHARES_PER_CONTRACT = 100;
const daysPerMonth = 30;

export interface RecoveryProjectionInput {
  costBasisPerShare: number;
  currentPrice: number;
  shares: number;
  contractsAvailable: number;
  candidate: Pick<CoveredCallCandidate, "premium" | "dte"> | null;
}

export interface RecoveryProjection {
  unrealizedLoss: number;
  monthlyPremium: number | null;
  monthsToRecover: number | null;
}

/** Pure arithmetic of the approved formula (see the header of evaluateRecoveryPathForPosition below). */
export function computeRecoveryProjection(input: RecoveryProjectionInput): RecoveryProjection {
  const { costBasisPerShare, currentPrice, shares, contractsAvailable, candidate } = input;
  const unrealizedLoss = Math.max(0, costBasisPerShare - currentPrice) * shares;
  const monthlyPremium = candidate && candidate.dte > 0 ? candidate.premium * SHARES_PER_CONTRACT * contractsAvailable * (daysPerMonth / candidate.dte) : null;
  const monthsToRecover = monthlyPremium !== null && monthlyPremium > 0 ? Math.ceil(unrealizedLoss / monthlyPremium) : null;
  return { unrealizedLoss, monthlyPremium, monthsToRecover };
}

export type RecoveryCostBasisSource = "cycle_break_even" | "entry_price";

/** The cycle break-even already nets the premium collected on the shares, so it is the cost to recover; the average entry price is only the fallback when the cycle cannot be trusted. */
export function chooseRecoveryCostBasis(entryPrice: number, cycleBreakEven: number | null): { costBasisPerShare: number; costBasisSource: RecoveryCostBasisSource } {
  return cycleBreakEven === null ? { costBasisPerShare: entryPrice, costBasisSource: "entry_price" } : { costBasisPerShare: cycleBreakEven, costBasisSource: "cycle_break_even" };
}

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
      costBasisPerShare: number;
      costBasisSource: RecoveryCostBasisSource;
      currentPrice: number;
      unrealizedLoss: number;
      contractsAvailable: number;
      candidate: CoveredCallCandidate | null;
      monthlyPremium: number | null;
      monthsToRecover: number | null;
      rationale: string;
    };

/**
 * On-demand recovery-path projection for an unstructured bare-stock
 * position (leftover from an expired covered call or an assigned CSP) --
 * "Recovery Path Formula" proposal, approved by Marcelo 2026-08-31, premium
 * scaled to a 30-day month 2026-09-24 (a 45-DTE candidate's premium is not a
 * monthly figure; the old formula treated it as one):
 *   unrealized loss = max(0, cost basis − current price) × shares, where the cost basis is the position's cycle break-even per
 *     share (premium already collected on the shares is netted out; approved 2026-10-02), or the average entry price when the
 *     cycle break-even is unavailable
 *   monthly premium = top-ranked live covered-call candidate's premium × 100 × contracts available × (30 ÷ candidate DTE)
 *   months to recover = ceil(unrealized loss ÷ monthly premium)
 * The candidate comes from scanRecoveryPathCoveredCallCandidates (the
 * delta band and expiry window in trading_settings).
 * Read-only, writes nothing. Borrows the shared read connection, or opens
 * its own short-lived one.
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
  const cycleBreakEven = (await fetchBreakEvenByPositionId([positionRow.tickerId])).get(positionId)?.breakEven ?? null;
  const { costBasisPerShare, costBasisSource } = chooseRecoveryCostBasis(entryPrice, cycleBreakEven);

  const targetWindow = await loadRecoveryTargetWindow();
  if (!targetWindow) return { status: "no_settings" };

  // FROZEN, not REALTIME — this is just an estimate, and it needs to work
  // outside market hours too (REALTIME's snapshot never completes with no
  // live trades to gate on). Runs on sharedReadConnection, not
  // sharedLiveConnection: that one is pinned to REALTIME for the life of the
  // connection for the Signals ticker modal's long-lived streams, and
  // changing type on a connection with subscriptions outstanding has been
  // seen to silently stop them (see requestMarketData.ts's
  // marketDataTypeManagedConnections comment). sharedReadConnection's
  // borrowers each set their own type per one-shot call instead, same as
  // fetchLivePrices/fetchLiveGreeks.
  const connection = await borrowSharedConnectionOrConnect(sharedReadConnection, "evaluateRecoveryPathForPosition");
  connection.ib.reqMarketDataType(MarketDataType.FROZEN);
  try {
    const pricing = await lookupPricingSnapshot(connection, positionRow.symbol, nextReqIdFor(connection.ib, () => 2), { resolveOnFirstLast: true });
    const currentPrice = pricing.last ?? (await getBestKnownStockPrice(positionRow.symbol)) ?? pricing.previousClose;
    if (currentPrice === null) throw new Error(`No current price available for ${positionRow.symbol}`);

    const contractsAvailable = Math.floor(shares / SHARES_PER_CONTRACT);
    const candidates =
      contractsAvailable >= 1
        ? await scanRecoveryPathCoveredCallCandidates(connection.ib, positionRow.symbol, positionRow.tickerId, currentPrice, targetWindow)
        : [];
    const candidate = candidates[0] ?? null;

    const { unrealizedLoss, monthlyPremium, monthsToRecover } = computeRecoveryProjection({ costBasisPerShare, currentPrice, shares, contractsAvailable, candidate });

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
      costBasisPerShare,
      costBasisSource,
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
