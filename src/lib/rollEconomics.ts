import { db } from "../db/connection.js";

// Approved 2026-08-31 (see PROGRESS.md's roll-economics decision): a roll is
// two separate fills -- buy-to-close the old leg, sell-to-open the
// replacement -- each paying its own commission and crossing its own
// bid/ask spread. Requiring the net credit collected to exceed the sum of
// these real, measured costs makes "this roll doesn't lose money on
// execution" a provable fact, not a guess. Deliberately does NOT attempt to
// guarantee the roll beats *not* rolling over the position's remaining life
// -- that depends on future price/IV paths nobody can know, and dressing an
// expected-value estimate up as a guarantee would be dishonest. See
// PROGRESS.md's backlog for that as a separate, explicitly probabilistic,
// low-priority feature.

// Below this many recent option fills, an average commission isn't a
// reliable estimate of what this account actually pays -- a sample-size
// judgment, not a claim about commission rates themselves.
const minimumFillsForReliableCommissionAverage = 5;
// How far back to look for those fills -- a recency window (rates can
// change if the account's tier changes), not a guess about the cost itself.
const recentFillsToConsider = 50;

// Real IBKR commissions actually paid on this account, sourced from
// trades.commission (IBKR's own CommissionReport -- see
// 20260812000006_create_trades.ts's header comment). Deliberately never a
// hardcoded published rate: this account's blended commission (regulatory
// fees, tiering) can differ from a generic published number, and the whole
// point of this module is to use real data instead of guessing.
export async function estimateAverageOptionCommissionPerContract(): Promise<number | null> {
  const rows: { perContract: string | null }[] = await db("trades as t")
    .join("position_legs as pl", "pl.id", "t.position_leg_id")
    .where("pl.leg_type", "option")
    .whereNotNull("t.commission")
    .orderBy("t.executed_at", "desc")
    .limit(recentFillsToConsider)
    .select(db.raw(`t.commission / NULLIF(t.quantity, 0) as "perContract"`));

  const values = rows.map((row) => Number(row.perContract)).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < minimumFillsForReliableCommissionAverage) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Half the quoted bid/ask spread is the realistic cost of crossing the
// market on one leg -- read directly off a live quote already being
// fetched, not assumed. Null bid/ask (premium fell back to last price)
// contributes $0 rather than an invented number -- same "no data, no
// penalty" convention as calendarUnverified/null ivRank elsewhere in this
// pipeline.
export function halfSpread(bid: number | null, ask: number | null): number {
  if (bid === null || ask === null) return 0;
  return (ask - bid) / 2;
}

// Commission component of a roll is a round trip (one fill to close the old
// leg, one to open the replacement) -- 2x the average per-contract
// commission. When there isn't enough fill history yet to trust that
// average, this is $0 (no data, no penalty) rather than a hardcoded
// published rate standing in for it -- the floor is weaker until real fills
// accumulate, but never fabricated.
export async function estimateRollCommissionComponent(): Promise<number> {
  const commissionPerContract = await estimateAverageOptionCommissionPerContract();
  return commissionPerContract !== null ? commissionPerContract * 2 : 0;
}
