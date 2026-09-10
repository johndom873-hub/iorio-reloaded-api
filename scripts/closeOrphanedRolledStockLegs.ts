// One-off cleanup for the AMAT/SPCX double-counted stock legs found via
// reconciliation drift alerts on 2026-09-10: rolling a covered call's short
// call to a new contract created a brand-new position for the new call but
// never closed or migrated the OLD position's stock leg (its conId is still
// held by IBKR, just now covering a different call, so the reconciliation
// closing pass never flagged it). Root cause fixed in
// upsertSplitCoveredCallPosition (ibkrGatewayWorker.ts) so this won't recur,
// but the fix doesn't retroactively repair these 2 already-orphaned legs —
// each new position already has its own (duplicate) stock leg by the time
// the fix runs, so the migration path never re-triggers for them.
//
// Closes each orphaned stock leg at its own entry_price (zero P&L — the
// shares were never sold, just re-tagged to a new position by the roll;
// same rationale as the existing isRetainedCoveredCallStock handling in
// ibkrGatewayWorker.ts), exit_at taken from the sibling option leg's own
// exit_at (the roll moment). Then closes the now-fully-closed old position,
// with close_reason derived the same way determineCloseReason would.
// Not meant to be a reusable script; delete after use.
//
// Usage (prod, via heroku run):
//   node dist/scripts/closeOrphanedRolledStockLegs.js          (preview only)
//   node dist/scripts/closeOrphanedRolledStockLegs.js --apply  (apply changes)

import { db } from "../src/db/connection.js";

const ORPHANED_STOCK_LEG_IDS = ["3a0f05d6-ab27-4179-93a8-392c421b3d8b", "4ccf304d-21a5-4468-806b-4c60d12abaf0"];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  for (const legId of ORPHANED_STOCK_LEG_IDS) {
    const leg = await db("position_legs").where({ id: legId }).first();
    if (!leg) {
      console.log(`${legId}: not found — skipping.`);
      continue;
    }
    if (leg.leg_type !== "stock" || leg.exit_at !== null) {
      console.log(`${legId}: not an open stock leg (leg_type=${leg.leg_type}, exit_at=${leg.exit_at}) — skipping, no change.`);
      continue;
    }

    const position = await db("positions").where({ id: leg.position_id }).first();
    const siblingOptionLeg = await db("position_legs")
      .where({ position_id: leg.position_id, leg_type: "option" })
      .first();
    const otherOpenLegs = await db("position_legs")
      .where({ position_id: leg.position_id })
      .whereNull("exit_at")
      .whereNot({ id: legId });

    console.log(`\n${legId} (position ${leg.position_id}, status=${position?.status}):`);
    console.log(`  leg: quantity=${leg.quantity}, entry_price=${leg.entry_price}, entry_at=${leg.entry_at}, ibkr_contract_id=${leg.ibkr_contract_id}`);
    console.log(
      `  sibling option leg: ${siblingOptionLeg ? `id=${siblingOptionLeg.id}, exit_at=${siblingOptionLeg.exit_at}` : "none found"}`,
    );
    console.log(`  other still-open legs on this position (should be none): ${otherOpenLegs.length}`);

    if (!siblingOptionLeg || siblingOptionLeg.exit_at === null) {
      console.log(`  SKIPPING: expected sibling option leg to already be closed (this is what makes the stock leg orphaned) — not touching.`);
      continue;
    }
    if (otherOpenLegs.length > 0) {
      console.log(`  SKIPPING: position has other open legs besides this stock leg — not the expected shape, not touching.`);
      continue;
    }

    const closingTrade = await db("trades as t")
      .join("position_legs as pl", "pl.id", "t.position_leg_id")
      .where({ "pl.position_id": leg.position_id, "t.is_closing_trade": true })
      .first();
    const filledOrderRequest = closingTrade
      ? await db("order_requests").where({ related_position_id: leg.position_id, status: "filled" }).first()
      : undefined;
    const closeReason = closingTrade ? (filledOrderRequest ? "closed_via_app" : "closed_via_external_trade") : "unknown";
    console.log(`  would close leg at exit_price=${leg.entry_price}, exit_at=${siblingOptionLeg.exit_at}; close position with close_reason=${closeReason}`);

    if (!apply) continue;

    await db("position_legs").where({ id: legId }).update({ exit_price: leg.entry_price, exit_at: siblingOptionLeg.exit_at });
    await db("positions")
      .where({ id: leg.position_id })
      .update({ status: "closed", closed_at: siblingOptionLeg.exit_at, close_reason: closeReason });
    console.log(`  APPLIED.`);
  }

  if (!apply) {
    console.log(`\nPreview only — rerun with --apply to write these changes.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
