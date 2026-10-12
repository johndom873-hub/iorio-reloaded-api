// The Heroku release phase (Procfile `release:`), one script so a release is all-or-nothing:
//
//   1. Deploy guard, before anything changes: production stops the release while the market is
//      open, within 15 min after the close, or with an order in flight; staging only warns.
//   2. Backup, only when this release has migrations to run (Heroku Postgres backup through the
//      Heroku API, HEROKU_RELEASE_API_KEY).
//   3. Migrations, all in one transaction (knex), so a failing migration changes nothing.
//   4. Worker deploy over SSH to the VPS, when the worker's source closure changed. The VPS script
//      switches the worker back by itself when the new build does not start cleanly.
//   5. If anything after step 3 fails: restore the step-2 backup, then exit non-zero so Heroku
//      keeps the previous code. The restore is refused (and the release still fails, loudly) when
//      orders or trades were written after the backup or the worker's state is unknown.
//   6. Fills the major macro events table once when it is empty (a new environment, or the
//      migration that created it), so Signals and order review have macro events before the open.
//
// A non-zero exit aborts the release: the web dyno keeps the previous code. SKIP_WORKER_DEPLOY_REASON
// skips the guard and the worker step (announced in Telegram) when the VPS is down and an API fix
// cannot wait. Rollback note: Heroku's Roll back runs the TARGET release's release command, so this
// script only protects releases made from a slug that contains it.
import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/db/connection.js";
import knexConfigs from "../src/db/knexfile.js";
import { environment, requireEnvironmentVariable } from "../src/config/env.js";
import { notifyTelegram } from "../src/lib/notifyTelegram.js";
import { runForcedCommandSsh } from "../src/ibkr/runForcedCommandSsh.js";
import { computeSourceClosureHash } from "../src/lib/computeSourceClosureHash.js";
import { decideWorkerDeployAction } from "../src/lib/decideWorkerDeployAction.js";
import { evaluateReleaseDeployGuard, inFlightOrderStatuses } from "../src/lib/releaseDeployGuard.js";
import { computeMarketSessionStatus, easternInstant } from "../src/lib/marketSessionStatus.js";
import { readAppEnvironment } from "../src/lib/appEnvironment.js";
import { easternIsoDate } from "../src/lib/easternIsoDate.js";
import { captureDatabaseBackup, herokuBackupName, resolveDatabaseAddonId, restoreDatabaseBackup, type HerokuBackupsClient, type HerokuPostgresTransfer } from "../src/lib/herokuPostgresBackups.js";
import {
  decideRestoreAfterFailedRelease,
  injectedReleaseFailureVariable,
  parseWorkerDeployResult,
  readInjectedReleaseFailure,
  workerStateAfterSshError,
  type WorkerStateAfterStep,
} from "../src/lib/releasePhaseDecisions.js";

const workerEntryFile = "src/ibkrGatewayWorker.ts";
const workerDeploySshTimeoutMs = 150_000; // npm ci + tsc build + up to a 30s health check, generous margin.
const workerDeployTimeoutMessage = "Timed out waiting for the worker deploy to finish on the VPS.";
const backupTimeoutMs = 10 * 60_000;
const restoreTimeoutMs = 20 * 60_000;
const macroEventFillTimeoutMs = 10 * 60_000;
const postCloseBufferMinutes = 15;

const scriptFile = fileURLToPath(import.meta.url);
const scriptsDirectory = path.dirname(scriptFile);
const scriptExtension = path.extname(scriptFile);
const migrationsDirectory = path.resolve(scriptsDirectory, "..", "src", "db", "migrations");

const releaseVersion = process.env.HEROKU_RELEASE_VERSION ?? "(unknown release)";
const slugCommit = process.env.HEROKU_SLUG_COMMIT ?? null;
const releaseLabel = `Release ${releaseVersion}${slugCommit ? ` (${slugCommit.slice(0, 7)})` : ""}`;

class ReleaseAborted extends Error {}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function abortRelease(message: string): Promise<never> {
  await notifyTelegram(message);
  throw new ReleaseAborted(message);
}

async function isWithinPostCloseBuffer(now: Date): Promise<boolean> {
  const dateIso = easternIsoDate(now);
  const regularClose = easternInstant(dateIso, 16, 0);
  const bufferEnd = new Date(regularClose.getTime() + postCloseBufferMinutes * 60_000);
  return now >= regularClose && now < bufferEnd;
}

async function runDeployGuard(): Promise<void> {
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
  const verdict = evaluateReleaseDeployGuard({ appEnvironment, marketSessionState: sessionStatus.state, isWithinPostCloseBuffer: withinBuffer, inFlightOrderCount });
  if (verdict.problems.length === 0) return;
  const problemText = verdict.problems.join("; ");
  if (verdict.shouldAbort) {
    await abortRelease(`🛑 ${releaseLabel} ABORTED by the deploy guard before changing anything: ${problemText}.
Same code, same database, same worker. Not a failure: promote again once the condition clears.`);
  }
  await notifyTelegram(`⚠️ The deploy guard would stop a production release right now (${problemText}). Proceeding, staging only warns.`);
  console.warn(`Deploy guard flagged (staging, proceeding anyway): ${problemText}`);
}

function migrationConfig() {
  const { migrations } = knexConfigs.production!;
  return { ...migrations, directory: migrationsDirectory, loadExtensions: [`.${migrations?.extension ?? "js"}`] };
}

function migrationName(entry: unknown): string {
  if (typeof entry === "string") return entry;
  const record = entry as { name?: string; file?: string };
  return record.name ?? record.file ?? String(entry);
}

async function listPublicTables(): Promise<string[]> {
  const rows = await db("pg_tables").where({ schemaname: "public" }).select<{ tablename: string }[]>("tablename");
  return rows.map((row) => row.tablename).sort();
}

async function latestAppliedMigration(): Promise<string | null> {
  const row = await db("knex_migrations").orderBy("id", "desc").first<{ name: string } | undefined>("name");
  return row?.name ?? null;
}

async function countTradingRowsSince(instant: Date): Promise<number> {
  const [orders, trades] = await Promise.all([
    db("order_requests").where("updated_at", ">", instant).count<{ count: string }[]>({ count: "*" }),
    db("trades").where("executed_at", ">", instant).count<{ count: string }[]>({ count: "*" }),
  ]);
  return Number(orders[0]?.count ?? 0) + Number(trades[0]?.count ?? 0);
}

interface WorkerStepOutcome {
  ok: boolean;
  workerState: WorkerStateAfterStep;
  summary: string;
}

async function deployWorker(): Promise<WorkerStepOutcome> {
  let localHash: string | null = null;
  try {
    localHash = computeSourceClosureHash(process.cwd(), workerEntryFile).hash;
  } catch (error) {
    console.warn(`Could not compute this release's worker source-closure hash (deploying to be safe): ${describeError(error)}`);
  }
  const workerHealthRow = await db("worker_health").where({ process_name: "ibkr_gateway_worker" }).first<{ worker_code_hash: string | null } | undefined>("worker_code_hash");
  const action = decideWorkerDeployAction({ localHash, storedHash: workerHealthRow?.worker_code_hash });
  if (action.kind === "skip_unchanged") {
    console.log(`Worker unchanged (hash ${action.hashPrefix}...) — skipping the worker deploy.`);
    return { ok: true, workerState: "untouched", summary: "worker unchanged" };
  }

  console.log(`Deploying the worker: ${action.reason}.`);
  await notifyTelegram(`⏳ ${releaseLabel}: deploying the worker (${action.reason})...`);
  const sshPrivateKey = Buffer.from(requireEnvironmentVariable("IBKR_WORKER_DEPLOY_SSH_PRIVATE_KEY_BASE64"), "base64");
  let output: string;
  let exitCode: number | null;
  try {
    ({ output, exitCode } = await runForcedCommandSsh({
      sshHost: environment.ibkrTunnelSshHost,
      sshPort: environment.ibkrTunnelSshPort,
      sshUsername: environment.ibkrTunnelSshUsername,
      sshPrivateKey,
      timeoutMs: workerDeploySshTimeoutMs,
      timeoutMessage: workerDeployTimeoutMessage,
    }));
  } catch (error) {
    const workerState = workerStateAfterSshError(error, workerDeployTimeoutMessage);
    console.error(`Worker deploy SSH failed: ${describeError(error)}`);
    return { ok: false, workerState, summary: `the worker deploy failed: ${workerState === "untouched" ? "could not reach the VPS" : "the SSH session broke off mid-deploy"} (${describeError(error)})` };
  }

  console.log(output);
  const result = parseWorkerDeployResult(output);
  if (result.kind === "deployed" || result.kind === "skipped_no_new_commit") {
    if (slugCommit && result.runningCommit && result.runningCommit !== slugCommit) {
      await notifyTelegram(`⚠️ ${releaseLabel}: the worker now runs ${result.runningCommit.slice(0, 7)} (origin/main), not this release's ${slugCommit.slice(0, 7)}. Something was pushed to main during the release; the next release brings the API level.`);
    }
    return { ok: true, workerState: "untouched", summary: result.kind === "deployed" ? `worker deployed (${result.detail})` : `worker already up to date (${result.detail})` };
  }
  if (result.kind === "rolled_back") {
    return { ok: false, workerState: "reverted", summary: `the new worker did not start cleanly and switched itself back to the previous build (${result.detail})` };
  }
  return { ok: false, workerState: "unknown", summary: `the worker deploy gave no result (exit code ${exitCode}); see the release output` };
}

async function restoreAfterFailure(params: {
  failure: string;
  workerState: WorkerStateAfterStep;
  backup: HerokuPostgresTransfer;
  backupsClient: HerokuBackupsClient;
  databaseAddonId: string;
  tablesBefore: string[];
  latestMigrationBefore: string | null;
}): Promise<never> {
  const backupName = herokuBackupName(params.backup);
  const decision = decideRestoreAfterFailedRelease({
    workerState: params.workerState,
    tradingRowsWrittenSinceBackup: await countTradingRowsSince(new Date(params.backup.finished_at!)),
  });
  if (!decision.restore) {
    return abortRelease(`🛑 ${releaseLabel} ABORTED: ${params.failure}.
Database NOT restored: ${decision.reason}. The API stays on the previous code, but the database already has this release's migrations. Fix forward; backup ${backupName} holds the database from before the release.`);
  }

  await notifyTelegram(`⏳ ${releaseLabel} failed after its migrations (${params.failure}). Restoring the database from backup ${backupName}...`);
  try {
    // Tables this release created are not in the backup, and their foreign keys to existing tables
    // would make the restore's DROP of those tables fail, so they go first.
    const tablesCreatedByRelease = (await listPublicTables()).filter((table) => !params.tablesBefore.includes(table));
    for (const table of tablesCreatedByRelease) await db.raw("DROP TABLE IF EXISTS ?? CASCADE", [table]);
    await restoreDatabaseBackup(params.backupsClient, params.databaseAddonId, params.backup, restoreTimeoutMs);
  } catch (error) {
    return abortRelease(`🛑🛑 ${releaseLabel} ABORTED: ${params.failure}. Restoring backup ${backupName} FAILED: ${describeError(error)}. The database may be half-restored: act now (heroku pg:backups:restore ${backupName}).`);
  }

  const [tablesAfter, latestMigrationAfter] = await Promise.all([listPublicTables(), latestAppliedMigration()]);
  const tablesMatch = tablesAfter.join(",") === params.tablesBefore.join(",");
  const migrationsMatch = latestMigrationAfter === params.latestMigrationBefore;
  const verification = tablesMatch && migrationsMatch
    ? `verified: same ${tablesAfter.length} tables, latest migration ${latestMigrationAfter ?? "none"}`
    : `CHECK BY HAND: ${tablesMatch ? "" : `tables differ (${tablesAfter.length} now vs ${params.tablesBefore.length} before); `}${migrationsMatch ? "" : `latest migration ${latestMigrationAfter} vs ${params.latestMigrationBefore} before`}`;
  const workerText = params.workerState === "reverted" ? "the worker switched itself back to the previous build" : "the worker was not touched";
  return abortRelease(`🛑 ${releaseLabel} ABORTED and rolled back: ${params.failure}.
Database restored from backup ${backupName} (${verification}); ${workerText}; the API stays on the previous code.`);
}

async function countMajorMacroEvents(): Promise<number> {
  const rows = await db("major_macro_events").count<{ count: string }[]>({ count: "*" });
  return Number(rows[0]?.count ?? 0);
}

async function fillEmptyMajorMacroEvents(): Promise<void> {
  if ((await countMajorMacroEvents()) > 0) return;
  console.log("major_macro_events is empty — running the calendar capture once.");
  const captureScript = path.join(scriptsDirectory, `run-daily-calendar-capture-job${scriptExtension}`);
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, captureScript], { stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGTERM"), macroEventFillTimeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      console.error(`Could not start the calendar capture: ${describeError(error)}`);
      resolve(null);
    });
  });
  // The job can record a failure for its earnings/dividend part and still exit 0, so judge by the table.
  if ((await countMajorMacroEvents()) === 0) {
    await notifyTelegram(`⚠️ ${releaseLabel}: the major macro events table is empty and filling it failed (calendar capture exit code ${exitCode}). Signals and order review show no macro events until the 20:00 UTC calendar job; run node dist/scripts/run-daily-calendar-capture-job.js if the market opens before then.`);
  }
}

async function main(): Promise<void> {
  const skipWorkerReason = process.env.SKIP_WORKER_DEPLOY_REASON;
  if (skipWorkerReason) {
    await notifyTelegram(`⚠️ ${releaseLabel}: worker deploy and deploy guard SKIPPED by override (SKIP_WORKER_DEPLOY_REASON="${skipWorkerReason}"). The worker was NOT touched and may now be behind the API.`);
  } else {
    await runDeployGuard();
  }

  const injectedFailure = readInjectedReleaseFailure(process.env[injectedReleaseFailureVariable], readAppEnvironment());
  const config = migrationConfig();
  const [, pendingEntries] = (await db.migrate.list(config)) as [unknown[], unknown[]];
  const pendingMigrations = pendingEntries.map(migrationName);

  let backupContext: { backup: HerokuPostgresTransfer; backupsClient: HerokuBackupsClient; databaseAddonId: string; tablesBefore: string[]; latestMigrationBefore: string | null } | null = null;
  if (pendingMigrations.length > 0) {
    const backupsClient: HerokuBackupsClient = { apiKey: requireEnvironmentVariable("HEROKU_RELEASE_API_KEY"), appName: requireEnvironmentVariable("HEROKU_APP_NAME") };
    const [tablesBefore, latestMigrationBefore] = await Promise.all([listPublicTables(), latestAppliedMigration()]);
    let databaseAddonId: string;
    let backup: HerokuPostgresTransfer;
    try {
      databaseAddonId = await resolveDatabaseAddonId(backupsClient);
      backup = await captureDatabaseBackup(backupsClient, databaseAddonId, backupTimeoutMs);
    } catch (error) {
      return abortRelease(`🛑 ${releaseLabel} ABORTED before its ${pendingMigrations.length} migration(s): the database backup failed (${describeError(error)}). Nothing changed.`);
    }
    console.log(`Backup ${herokuBackupName(backup)} captured before ${pendingMigrations.length} migration(s).`);
    backupContext = { backup, backupsClient, databaseAddonId, tablesBefore, latestMigrationBefore };

    try {
      await db.migrate.latest(config);
    } catch (error) {
      return abortRelease(`🛑 ${releaseLabel} ABORTED: a migration failed (${describeError(error)}). The migrations run in one transaction, so the database is unchanged; same code, same worker.`);
    }
    console.log(`Applied ${pendingMigrations.length} migration(s): ${pendingMigrations.join(", ")}`);
  }

  let workerOutcome: WorkerStepOutcome;
  if (injectedFailure === "after_migrations") {
    workerOutcome = { ok: false, workerState: "untouched", summary: `test failure injected by ${injectedReleaseFailureVariable} (staging only)` };
  } else if (skipWorkerReason) {
    workerOutcome = { ok: true, workerState: "untouched", summary: "worker skipped by override" };
  } else {
    workerOutcome = await deployWorker();
  }

  if (!workerOutcome.ok) {
    if (backupContext) return restoreAfterFailure({ failure: workerOutcome.summary, workerState: workerOutcome.workerState, ...backupContext });
    return abortRelease(`🛑 ${releaseLabel} ABORTED: ${workerOutcome.summary}. No migrations ran, so the database is unchanged; the API stays on the previous code.`);
  }

  if (backupContext) {
    await db("release_backups").insert({
      heroku_release_version: process.env.HEROKU_RELEASE_VERSION ?? null,
      slug_commit: slugCommit,
      backup_name: herokuBackupName(backupContext.backup),
      backup_transfer_uuid: backupContext.backup.uuid,
      backup_finished_at: backupContext.backup.finished_at,
      latest_migration_before: backupContext.latestMigrationBefore,
      migrations_applied: JSON.stringify(pendingMigrations),
    });
  }
  await fillEmptyMajorMacroEvents();

  if (backupContext || workerOutcome.summary !== "worker unchanged") {
    const migrationText = backupContext ? `${pendingMigrations.length} migration(s) applied after backup ${herokuBackupName(backupContext.backup)}` : "no migrations";
    await notifyTelegram(`✅ ${releaseLabel}: ${migrationText}; ${workerOutcome.summary}.`);
  }
}

runScript(
  "run-release-phase",
  async () => {
    try {
      await main();
    } catch (error) {
      // Already announced in Telegram by abortRelease; only the exit code is left to set.
      if (!(error instanceof ReleaseAborted)) throw error;
      console.error(error.message);
      process.exitCode = 1;
    }
  },
  () => db.destroy(),
);
