import type { IBApi } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { fetchIbkrHeldPositions } from "./fetchIbkrHeldPositions.js";

interface OpenLegRow {
  id: string;
  ibkr_contract_id: string;
  quantity: number;
  leg_type: string;
  symbol: string;
}

/**
 * Compares IBKR's actual current holdings against every open position_legs
 * row and reports any discrepancy — detection only, fixes nothing. Built
 * 2026-08-25 after two real bugs surfaced the same day (both since fixed in
 * ibkrWorker.ts): a repeat opening fill for an already-tracked contract left
 * `quantity` stuck at its original value instead of accumulating, and a
 * partial closing fill marked an entire multi-lot leg closed instead of
 * just the filled portion. ibkrWorker.ts's continuous reconciliation
 * (reconcilePositionsFromIbkr, every 60s) already self-heals most drift —
 * but self-healing silently isn't the same as anyone being told it
 * happened, and it can't help at all if the worker itself is down. This is
 * the alerting layer for exactly that gap.
 */
export async function checkPositionReconciliation(ib: IBApi): Promise<string[]> {
  const held = await fetchIbkrHeldPositions(ib);
  const heldByConId = new Map(held.map((position) => [String(position.contract.conId), position]));

  const openLegs: OpenLegRow[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .whereNull("pl.exit_at")
    .whereNotNull("pl.ibkr_contract_id")
    .select("pl.id", "pl.ibkr_contract_id", "pl.quantity", "pl.leg_type", "t.symbol as symbol");
  const openLegsByConId = new Map(openLegs.map((leg) => [leg.ibkr_contract_id, leg]));

  const problems: string[] = [];

  for (const [conId, position] of heldByConId) {
    const leg = openLegsByConId.get(conId);
    if (!leg) {
      problems.push(
        `IBKR holds ${Math.abs(position.quantity)} of ${position.contract.symbol ?? "?"} (conId ${conId}) with no matching open position_legs row.`,
      );
      continue;
    }
    const trueQuantity = Math.abs(position.quantity);
    if (trueQuantity !== leg.quantity) {
      problems.push(`${leg.symbol} ${leg.leg_type} leg ${leg.id}: position_legs.quantity=${leg.quantity} but IBKR reports ${trueQuantity}.`);
    }
  }

  for (const [conId, leg] of openLegsByConId) {
    if (!heldByConId.has(conId)) {
      problems.push(`${leg.symbol} ${leg.leg_type} leg ${leg.id} is marked open (quantity ${leg.quantity}) but IBKR reports no holding for conId ${conId}.`);
    }
  }

  return problems;
}
