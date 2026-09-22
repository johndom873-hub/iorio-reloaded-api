// Phase B WP4: runs as part of the Heroku release phase (after migrate:latest:prod, see
// Procfile), deciding whether this release needs to redeploy the trading worker and, if so,
// triggering it over SSH -- so the API and the worker are provably on the same commit at the end
// of every release, never drifting apart silently the way a manual, separate worker deploy could.
//
// Skip decision: computeSourceClosureHash walks THIS commit's worker-relevant source closure and
// compares it against worker_health.worker_code_hash (what the currently-running worker reports
// having). Identical -> this release doesn't touch anything the worker runs -> skip the SSH round
// trip entirely, but still send a Telegram message either way (Marcelo asked for that explicitly --
// silence on a skip would look identical to a script that silently stopped working). Anything that
// makes the comparison inconclusive (no worker_health row yet, a stale/offline worker, src/ missing
// from this dyno for some reason) fails toward DEPLOYING, never toward silently skipping.
//
// Fail-closed atomicity: on a genuine deploy failure (the VPS script itself reports rolled_back,
// or the SSH call never completes -- an unreachable VPS, a timeout), this script exits non-zero,
// which aborts the WHOLE Heroku release -- the web dyno never updates either, so the API and the
// worker can never end up on different commits as the visible result of one release. The one
// override is the SKIP_WORKER_DEPLOY_REASON config var: set it to ship anyway (e.g. the VPS is
// down for unrelated reasons and an urgent API fix can't wait) and the override is announced in
// Telegram, never silent.
//
// Deploy guard (checked before any of the above, unless the override is set): order-flow is
// DAY-only everywhere, so redeploying the worker while the market is open, within ~15 min after
// close, or with anything genuinely in flight is the exact risk this guard exists to catch.
// Production ABORTS the release on any of those; staging only WARNS and proceeds (see
// releaseDeployGuard.ts) -- else every daytime push during active staging development would fail.
import "dotenv/config";
import { db } from "../src/db/connection.js";
import { environment, requireEnvironmentVariable } from "../src/config/env.js";
import { notifyTelegram } from "../src/lib/notifyTelegram.js";
import { runForcedCommandSsh } from "../src/ibkr/runForcedCommandSsh.js";
import { computeSourceClosureHash } from "../src/lib/computeSourceClosureHash.js";
import { decideWorkerDeployAction } from "../src/lib/decideWorkerDeployAction.js";
import { evaluateReleaseDeployGuard, inFlightOrderStatuses } from "../src/lib/releaseDeployGuard.js";
import { computeMarketSessionStatus, easternDateIso, easternInstant } from "../src/lib/marketSessionStatus.js";
import { readAppEnvironment } from "../src/lib/appEnvironment.js";

const workerEntryFile = "src/ibkrGatewayWorker.ts";
const sshTimeoutMs = 150_000; // npm ci + tsc build + up to a 30s health check, generous margin.

interface WorkerHealthRow {
  worker_code_hash: string | null;
  updated_at: Date;
}

const postCloseBufferMinutes = 15;

async function isWithinPostCloseBuffer(now: Date): Promise<boolean> {
  const dateIso = easternDateIso(now);
  const regularClose = easternInstant(dateIso, 16, 0);
  const bufferEnd = new Date(regularClose.getTime() + postCloseBufferMinutes * 60_000);
  return now >= regularClose && now < bufferEnd;
}

async function main(): Promise<void> {
  // Checked first, ahead of the deploy guard: an explicit override means the worker is not going
  // to be touched at all, so there is nothing for the guard to protect against.
  const skipOverrideReason = process.env.SKIP_WORKER_DEPLOY_REASON;
  if (skipOverrideReason) {
    await notifyTelegram(`⚠️ Worker deploy step SKIPPED by override (SKIP_WORKER_DEPLOY_REASON="${skipOverrideReason}"). The worker was NOT touched by this release — it may now be behind the API.`);
    console.log(`Worker deploy skipped by explicit override: ${skipOverrideReason}`);
    return;
  }

  const appEnvironment = readAppEnvironment();
  const now = new Date();
  const [sessionStatus, withinBuffer, inFlightOrderCount] = await Promise.all([
    computeMarketSessionStatus(now),
    isWithinPostCloseBuffer(now),
    db("order_requests")
      .whereIn("status", inFlightOrderStatuses)
      .count<{ count: string }[]>({ count: "*" })
      .then((rows) => Number(rows[0]?.count ?? 0)),
  ]);
  const guardVerdict = evaluateReleaseDeployGuard({
    appEnvironment,
    marketSessionState: sessionStatus.state,
    isWithinPostCloseBuffer: withinBuffer,
    inFlightOrderCount,
  });
  if (guardVerdict.problems.length > 0) {
    const problemText = guardVerdict.problems.join("; ");
    if (guardVerdict.shouldAbort) {
      await notifyTelegram(`🛑 Worker deploy step ABORTED by the deploy guard: ${problemText}.
Release ABORTED — the API was NOT deployed either. This is not a failure, it's the guard doing its job; the next push will retry once the condition clears.`);
      console.error(`Deploy guard aborted the release: ${problemText}`);
      process.exitCode = 1;
      return;
    }
    await notifyTelegram(`⚠️ Worker deploy guard would abort a production release right now (${problemText}) — proceeding anyway, staging only warns.`);
    console.warn(`Deploy guard flagged (staging, proceeding anyway): ${problemText}`);
  }

  let localHash: string | null = null;
  try {
    localHash = computeSourceClosureHash(process.cwd(), workerEntryFile).hash;
  } catch (error) {
    console.warn(`Could not compute this release's worker source-closure hash (deploying to be safe): ${error instanceof Error ? error.message : error}`);
  }

  const workerHealthRow: WorkerHealthRow | undefined = await db("worker_health").where({ process_name: "ibkr_gateway_worker" }).first();

  const action = decideWorkerDeployAction({ localHash, storedHash: workerHealthRow?.worker_code_hash });

  if (action.kind === "skip_unchanged") {
    await notifyTelegram(`ℹ️ Worker deploy step: skipped — this release doesn't change anything the worker runs (source hash unchanged).`);
    console.log(`Worker unchanged (hash ${action.hashPrefix}...) — skipping the worker deploy.`);
    return;
  }

  console.log(`Deploying the worker: ${action.reason}.`);
  await notifyTelegram(`⏳ Worker deploy step: starting (${action.reason})...`);

  const sshPrivateKey = Buffer.from(requireEnvironmentVariable("IBKR_WORKER_DEPLOY_SSH_PRIVATE_KEY_BASE64"), "base64");

  let sshResult: { exitCode: number | null; output: string };
  try {
    sshResult = await runForcedCommandSsh({
      sshHost: environment.ibkrTunnelSshHost,
      sshPort: environment.ibkrTunnelSshPort,
      sshUsername: environment.ibkrTunnelSshUsername,
      sshPrivateKey,
      timeoutMs: sshTimeoutMs,
      timeoutMessage: "Timed out waiting for the worker deploy to finish on the VPS.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await notifyTelegram(`🛑 Worker deploy step FAILED: could not reach the VPS (${message}). Release ABORTED — the API was NOT deployed either, so it stays on the same commit as the worker.\nOverride with SKIP_WORKER_DEPLOY_REASON if this needs to ship anyway.`);
    console.error(`SSH to the VPS failed: ${message}`);
    process.exitCode = 1;
    return;
  }

  console.log(sshResult.output);
  const resultLine = sshResult.output.match(/^DEPLOY_RESULT=(\S+)(.*)$/m);
  const resultKind = resultLine?.[1];

  if (resultKind === "deployed" || resultKind === "skipped_no_new_commit") {
    const detail = resultLine?.[2]?.trim() ?? "";
    await notifyTelegram(`✅ Worker deploy step: ${resultKind === "deployed" ? "deployed" : "already up to date"}. ${detail}`);
    console.log(`Worker deploy step succeeded (${resultKind}).`);
    return;
  }

  // rolled_back, or anything unparseable (SSH connected but the script's own output didn't
  // include a result line -- treat identically to a failure, since we can't confirm success).
  const detail = resultLine?.[2]?.trim() ?? "no DEPLOY_RESULT line in the output — see the full output above.";
  await notifyTelegram(`🛑 Worker deploy FAILED (exit code ${sshResult.exitCode}): ${detail}\nRelease ABORTED — the API was NOT deployed either, so it stays on the same commit as the worker.\nOverride with SKIP_WORKER_DEPLOY_REASON if this needs to ship anyway.`);
  console.error(`Worker deploy step failed (result=${resultKind ?? "unparseable"}, exit code ${sshResult.exitCode}).`);
  process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
