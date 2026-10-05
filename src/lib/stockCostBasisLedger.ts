import type { Knex } from "knex";
import { db } from "../db/connection.js";

// Cost basis of held shares, rebuilt from the trades ledger (approved 2026-10-02, see PROGRESS.md "Assigned-put
// premium counted twice while shares are open").
//
// IBKR reports shares acquired by an assigned short put at (strike - put premium per share), while the put leg also
// keeps that premium, so the premium is counted twice. IBKR also reports ONE average cost per contract, over the lots
// it still holds under the account's FIFO match method. So the true cost of what is held is the FIFO average of the
// remaining lots, with each assigned lot priced at the strike.
//
// The rebuild is only used when it reproduces IBKR's own numbers: the share count must equal IBKR's, and the same
// FIFO average built with IBKR's convention (assigned lots at strike - premium) must equal IBKR's reported average
// cost within costBasisMatchTolerancePerShare. Anything else (a missing trade, a different match method, a fill
// still in flight) is "unverified" and the caller keeps IBKR's value untouched.

export const costBasisMatchTolerancePerShare = 0.015;
const assignmentFillWindowMs = 36 * 3_600_000;
const strikeMatchTolerance = 0.00005;
const entryPriceDecimals = 4;
const recentPutSettlementDays = 7;

export interface LedgerStockTrade {
  id: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  commission: number | null;
  executedAt: Date;
}

/** A short put that ended without a closing trade (expired or assigned). */
export interface LedgerSettledPut {
  strike: number;
  premiumPerShare: number;
  shares: number;
  exitAt: Date;
}

export interface CostBasisLot {
  quantity: number;
  /** Per share, the way IBKR reports it: an assigned lot is strike - premium. */
  ibkrCostPerShare: number;
  /** Per share with an assigned lot at the strike (the put keeps its premium separately). */
  trueCostPerShare: number;
}

export interface SaleConsumption {
  quantity: number;
  trueCost: number;
}

export interface FifoLedger {
  lots: CostBasisLot[];
  shares: number;
  /** A sale larger than the lots held: the ledger is missing buys. */
  oversold: boolean;
  saleConsumptionByTradeId: Map<string, SaleConsumption>;
}

export type CostBasisVerdict =
  | { verified: true; adjustedEntryPrice: number }
  | { verified: false; reason: "no_ledger_shares" | "oversold" | "share_count" | "average_cost" };

function roundEntryPrice(value: number): number {
  return Number(value.toFixed(entryPriceDecimals));
}

/**
 * FIFO lots from the ticker's stock trades. A buy at exactly a settled put's strike, within the assignment window of
 * that put's exit, is the assignment fill; each put absorbs at most its own share count.
 */
export function buildFifoLedger(trades: LedgerStockTrade[], settledPuts: LedgerSettledPut[], throughExecutedAt?: Date): FifoLedger {
  const unabsorbedPuts = settledPuts.map((put) => ({ ...put, remainingShares: put.shares }));
  const lots: CostBasisLot[] = [];
  const saleConsumptionByTradeId = new Map<string, SaleConsumption>();
  let oversold = false;

  const orderedTrades = [...trades].sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime() || a.id.localeCompare(b.id));
  for (const trade of orderedTrades) {
    if (throughExecutedAt && trade.executedAt.getTime() > throughExecutedAt.getTime()) continue;

    if (trade.side === "buy") {
      const commissionPerShare = (trade.commission ?? 0) / trade.quantity;
      let unassignedShares = trade.quantity;
      for (;;) {
        const assignedPut = unassignedShares > 0 ? unabsorbedPuts.find((put) => put.remainingShares > 0 && Math.abs(put.strike - trade.price) < strikeMatchTolerance && Math.abs(put.exitAt.getTime() - trade.executedAt.getTime()) <= assignmentFillWindowMs) : undefined;
        if (!assignedPut) break;
        const assignedShares = Math.min(unassignedShares, assignedPut.remainingShares);
        assignedPut.remainingShares -= assignedShares;
        unassignedShares -= assignedShares;
        lots.push({ quantity: assignedShares, ibkrCostPerShare: trade.price - assignedPut.premiumPerShare + commissionPerShare, trueCostPerShare: trade.price + commissionPerShare });
      }
      if (unassignedShares > 0) lots.push({ quantity: unassignedShares, ibkrCostPerShare: trade.price + commissionPerShare, trueCostPerShare: trade.price + commissionPerShare });
      continue;
    }

    let remainingToSell = trade.quantity;
    let consumedQuantity = 0;
    let consumedTrueCost = 0;
    while (remainingToSell > 0 && lots.length > 0) {
      const oldestLot = lots[0]!;
      const taken = Math.min(remainingToSell, oldestLot.quantity);
      consumedQuantity += taken;
      consumedTrueCost += taken * oldestLot.trueCostPerShare;
      remainingToSell -= taken;
      oldestLot.quantity -= taken;
      if (oldestLot.quantity === 0) lots.shift();
    }
    if (remainingToSell > 0) oversold = true;
    saleConsumptionByTradeId.set(trade.id, { quantity: consumedQuantity, trueCost: consumedTrueCost });
  }

  return { lots, shares: lots.reduce((sum, lot) => sum + lot.quantity, 0), oversold, saleConsumptionByTradeId };
}

function lotAverages(lots: CostBasisLot[]): { shares: number; ibkrAverage: number; trueAverage: number; trueCost: number } {
  const shares = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const ibkrCost = lots.reduce((sum, lot) => sum + lot.ibkrCostPerShare * lot.quantity, 0);
  const trueCost = lots.reduce((sum, lot) => sum + lot.trueCostPerShare * lot.quantity, 0);
  return { shares, ibkrAverage: ibkrCost / shares, trueAverage: trueCost / shares, trueCost };
}

/**
 * Accepts the ledger only when it matches IBKR's holding. The entry price returned is IBKR's own average cost plus the
 * premium still baked into the remaining assigned lots (zero when none remain, so then it is IBKR's value exactly), which keeps
 * everything else in IBKR's number, such as opening commissions, as reported.
 */
export function verifyLedgerAgainstIbkr(ledger: FifoLedger, heldShares: number, heldAverageCost: number): CostBasisVerdict {
  if (ledger.oversold) return { verified: false, reason: "oversold" };
  if (ledger.shares <= 0) return { verified: false, reason: "no_ledger_shares" };
  if (ledger.shares !== heldShares) return { verified: false, reason: "share_count" };
  const { ibkrAverage, trueAverage } = lotAverages(ledger.lots);
  if (!(Math.abs(ibkrAverage - heldAverageCost) <= costBasisMatchTolerancePerShare)) return { verified: false, reason: "average_cost" };
  return { verified: true, adjustedEntryPrice: roundEntryPrice(heldAverageCost + (trueAverage - ibkrAverage)) };
}

/**
 * Cost per share of the shares the given sale fills consumed under FIFO, or null when the parent leg's own entry is
 * already right: the sold lots cost the same as the rest (within the match tolerance), or the fills are unknown to the ledger.
 * Call with a ledger built through the last of those fills.
 */
export function soldSharesEntryPrice(ledgerThroughLastFill: FifoLedger, soldTradeIds: string[]): number | null {
  let soldQuantity = 0;
  let soldTrueCost = 0;
  for (const tradeId of soldTradeIds) {
    const consumption = ledgerThroughLastFill.saleConsumptionByTradeId.get(tradeId);
    if (!consumption) return null;
    soldQuantity += consumption.quantity;
    soldTrueCost += consumption.trueCost;
  }
  if (soldQuantity === 0) return null;
  const soldPerShare = soldTrueCost / soldQuantity;
  const averageBeforeSale = (soldTrueCost + lotAverages(ledgerThroughLastFill.lots).trueCost) / (soldQuantity + ledgerThroughLastFill.shares);
  if (Math.abs(soldPerShare - averageBeforeSale) <= costBasisMatchTolerancePerShare) return null;
  return roundEntryPrice(soldPerShare);
}

export async function loadLedgerInputs(tickerId: string, database: Knex = db): Promise<{ trades: LedgerStockTrade[]; settledPuts: LedgerSettledPut[] }> {
  const tradeRows = await database("trades as tr")
    .join("position_legs as pl", "pl.id", "tr.position_leg_id")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.ticker_id": tickerId, "pl.leg_type": "stock" })
    .select("tr.id", "tr.side", "tr.quantity", "tr.price", "tr.commission", "tr.executed_at");
  const putRows = await database("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.ticker_id": tickerId, "pl.leg_type": "option", "pl.option_type": "put", "pl.side": "short" })
    .whereNotNull("pl.exit_at")
    .whereNotExists(database("trades as closing").whereRaw("closing.position_leg_id = pl.id").where("closing.is_closing_trade", true))
    .select("pl.strike_price", "pl.entry_price", "pl.quantity", "pl.multiplier", "pl.exit_at");

  return {
    trades: tradeRows.map((row) => ({ id: row.id, side: row.side, quantity: Number(row.quantity), price: Number(row.price), commission: row.commission === null ? null : Number(row.commission), executedAt: new Date(row.executed_at) })),
    settledPuts: putRows.map((row) => ({ strike: Number(row.strike_price), premiumPerShare: Number(row.entry_price), shares: Number(row.quantity) * Number(row.multiplier), exitAt: new Date(row.exit_at) })),
  };
}

export interface HeldStockCostBasis {
  verdict: CostBasisVerdict;
  /** A short put settled in the last week: if the verdict is unverified, an assignment's premium may still be counted twice. */
  hasRecentPutSettlement: boolean;
}

/** Verifies the ticker's rebuilt cost basis against what IBKR holds right now. */
export async function verifyHeldStockCostBasis(tickerId: string, heldShares: number, heldAverageCost: number, database: Knex = db): Promise<HeldStockCostBasis> {
  const { trades, settledPuts } = await loadLedgerInputs(tickerId, database);
  const verdict = verifyLedgerAgainstIbkr(buildFifoLedger(trades, settledPuts), heldShares, heldAverageCost);
  const recentCutoffMs = Date.now() - recentPutSettlementDays * 86_400_000;
  return { verdict, hasRecentPutSettlement: settledPuts.some((put) => put.exitAt.getTime() >= recentCutoffMs) };
}

/**
 * The cost per share of shares just sold in a partial close, when the ledger (verified against what IBKR holds after the sale)
 * shows they were a different lot than the average; null to keep the parent leg's entry.
 */
export async function soldFillsEntryPrice(
  tickerId: string,
  soldFills: { id: string; executedAt: Date }[],
  heldShares: number,
  heldAverageCost: number,
  database: Knex = db,
): Promise<number | null> {
  const { trades, settledPuts } = await loadLedgerInputs(tickerId, database);
  const lastFillAt = new Date(Math.max(...soldFills.map((fill) => fill.executedAt.getTime())));
  const ledger = buildFifoLedger(trades, settledPuts, lastFillAt);
  if (!verifyLedgerAgainstIbkr(ledger, heldShares, heldAverageCost).verified) return null;
  return soldSharesEntryPrice(ledger, soldFills.map((fill) => fill.id));
}
