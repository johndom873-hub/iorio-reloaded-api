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
import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import "dotenv/config";
import { db } from "../src/db/connection.js";
import { runJob } from "../src/lib/runJob.js";
import { readExpirySettlementMode, runExpirySettlementAudit, summarizeExpirySettlement } from "../src/lib/expirySettlementAudit.js";

async function main() {
  const mode = readExpirySettlementMode();
  await runJob("expiry_settlement_audit", async () => {
    const result = await runExpirySettlementAudit(mode);
    const { changes, skipped, pnlDelta, notify } = summarizeExpirySettlement(mode, result);
    for (const action of result.actions) console.log(`[${mode}] ${action.kind}: ${action.description}`);
    console.log(`Expiry settlement audit (${mode}): ${result.legsExamined} expired short leg(s) examined, ${changes.length} correction(s), ${skipped.length} skipped.`);

    return {
      details: { mode, legsExamined: result.legsExamined, corrections: changes.length, skipped: skipped.map((action) => action.description), pnlDelta },
      notify,
      // Skipped legs (no expiry bar, share-count mismatch, a call too close to call) leave realized P&L wrong until someone
      // acts, so the nightly run is recorded as a failure every night they persist. Free of "): " (Telegram truncation).
      failureMessage: skipped.length > 0 ? `${skipped.length} expired leg(s) need review or could not be audited, ${skipped.map((action) => action.description).join(" | ").replaceAll("): ", ") - ")}` : undefined,
    };
  });
}

runScript("run-daily-expiry-settlement-audit-job", main, () => db.destroy());
