import type { IBApi } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { fetchIbkrHeldPositions } from "./ibkrGatewayFetchHeldPositions.js";

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
 * ibkrGatewayWorker.ts): a repeat opening fill for an already-tracked contract left
 * `quantity` stuck at its original value instead of accumulating, and a
 * partial closing fill marked an entire multi-lot leg closed instead of
 * just the filled portion. ibkrGatewayWorker.ts's continuous reconciliation
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

  // Grouped by conId, not a 1:1 map — a covered call's stock conId can be
  // legitimately split across several sibling positions (added 2026-08-25,
  // see ibkrGatewayWorker.ts's upsertSplitCoveredCallPosition), so IBKR's one real
  // holding for that conId has to be compared against the SUM of every
  // local leg sharing it, not an arbitrary single one (a naive Map.get
  // here reported a false-positive drift the first time this was tested
  // against a real split position).
  const openLegsByConId = new Map<string, OpenLegRow[]>();
  for (const leg of openLegs) {
    const group = openLegsByConId.get(leg.ibkr_contract_id) ?? [];
    group.push(leg);
    openLegsByConId.set(leg.ibkr_contract_id, group);
  }

  const problems: string[] = [];

  for (const [conId, position] of heldByConId) {
    const legs = openLegsByConId.get(conId);
    if (!legs || legs.length === 0) {
      problems.push(
        `IBKR holds ${Math.abs(position.quantity)} of ${position.contract.symbol ?? "?"} (conId ${conId}) with no matching open position_legs row.`,
      );
      continue;
    }
    const trueQuantity = Math.abs(position.quantity);
    const localTotal = legs.reduce((sum, leg) => sum + leg.quantity, 0);
    if (trueQuantity !== localTotal) {
      const legDescription = legs.length === 1 ? `leg ${legs[0]!.id}` : `${legs.length} split legs (${legs.map((l) => l.id).join(", ")})`;
      problems.push(`${legs[0]!.symbol} ${legs[0]!.leg_type} ${legDescription}: local total quantity=${localTotal} but IBKR reports ${trueQuantity}.`);
    }
  }

  for (const [conId, legs] of openLegsByConId) {
    if (!heldByConId.has(conId)) {
      const localTotal = legs.reduce((sum, leg) => sum + leg.quantity, 0);
      problems.push(
        `${legs[0]!.symbol} ${legs[0]!.leg_type} leg(s) marked open (total quantity ${localTotal}) but IBKR reports no holding for conId ${conId}.`,
      );
    }
  }

  // Diagnostic dump for the next time this fires — 2026-09-01 saw a run
  // flag 8 "no matching row" problems for legs that, on direct inspection
  // moments later, had existed correctly in the DB for up to 21 hours (not
  // freshly created around the alert). The likely explanation is a bad
  // read on this function's own one-off IBKR connection or DB query, not
  // real data drift, but that couldn't be confirmed after the fact — this
  // gives a raw snapshot to compare against if it recurs.
  if (problems.length > 0) {
    console.log(
      `checkPositionReconciliation: held conIds = [${[...heldByConId.keys()].sort().join(", ")}], ` +
        `open leg conIds = [${[...openLegsByConId.keys()].sort().join(", ")}]`,
    );
  }

  return problems;
}
