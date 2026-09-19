// Scheduled job #8: nightly expiry-settlement audit-and-correct — finds expired
// short options that finished in the money but were recorded as worthless,
// and (in apply mode) corrects the called-away stock exit price and the
// position's close_reason. Full reasoning: src/lib/expirySettlementAudit.ts.
//
// Must run after daily-market-data (which captures the expiry day's daily
// bar); a leg with no expiry-date bar yet is simply retried next run.
//
// EXPIRY_SETTLEMENT_MODE is required: "dry_run" (log + notify what it WOULD
// change, write nothing) or "apply". Ship in dry_run, review the notification,
// then switch to apply.
//
// Usage (dev):
//   npm run job:expiry-settlement-audit
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-daily-expiry-settlement-audit-job.js
import "dotenv/config";
import { db } from "../src/db/connection.js";
import { requireEnvironmentVariable } from "../src/config/env.js";
import { runJob } from "../src/lib/runJob.js";
import { runExpirySettlementAudit, type ExpirySettlementMode } from "../src/lib/expirySettlementAudit.js";

function readMode(): ExpirySettlementMode {
  const value = requireEnvironmentVariable("EXPIRY_SETTLEMENT_MODE");
  if (value !== "dry_run" && value !== "apply") {
    throw new Error(`EXPIRY_SETTLEMENT_MODE must be "dry_run" or "apply", got: ${value}`);
  }
  return value;
}

async function main() {
  const mode = readMode();
  await runJob("expiry_settlement_audit", async () => {
    const result = await runExpirySettlementAudit(mode);
    const changes = result.actions.filter((action) => action.kind !== "skipped");
    const skipped = result.actions.filter((action) => action.kind === "skipped");
    for (const action of result.actions) console.log(`[${mode}] ${action.kind}: ${action.description}`);
    console.log(`Expiry settlement audit (${mode}): ${result.legsExamined} expired short leg(s) examined, ${changes.length} correction(s), ${skipped.length} skipped.`);

    const pnlDelta = result.realizedPnlDelta;
    // Skipped items repeat every night until fixed by hand, so they never trigger a message on their own.
    const notify =
      changes.length === 0
        ? undefined
        : `Expiry settlement audit (${mode === "apply" ? "APPLIED" : "DRY RUN — nothing changed"}): ${changes.length} correction(s), realized P&L ${pnlDelta >= 0 ? "+" : "-"}$${Math.abs(pnlDelta).toFixed(2)}.\n` +
          changes.map((action) => `• ${action.description}`).join("\n") +
          (skipped.length > 0 ? `\n${skipped.length} item(s) need manual review (see job log).` : "");
    return {
      details: { mode, legsExamined: result.legsExamined, corrections: changes.length, skipped: skipped.map((action) => action.description), pnlDelta },
      notify,
    };
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
