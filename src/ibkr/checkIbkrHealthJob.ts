import { restartIbkrGatewayOnVps } from "./restartIbkrGatewayOnVps.js";
import { describeLiveGatewayManualLoginHeadline, parseGatewayControlResultKind } from "./gatewayControlResult.js";
import { checkWorkerOnVps } from "./checkWorkerOnVps.js";
import { connectToIbkrGateway, type IbkrConnection, type IbkrConnectionNotice } from "./connectIbkr.js";
import { checkPositionReconciliation } from "./checkPositionReconciliation.js";
import { lookupLatestDailyBar } from "./fetchTickerOverview.js";
import { describeThrown, JobFailedWithDetailsError, runJob } from "../lib/runJob.js";
import { environment } from "../config/env.js";
import { db } from "../db/connection.js";
import { reportMarketQuoteLoopLiveness } from "../lib/marketQuoteLoopLiveness.js";
import { reportOpsMonitorLiveness } from "../lib/opsMonitorLiveness.js";
import { reportWorkerHeartbeat } from "../lib/workerHeartbeatLiveness.js";
import { liveDataProbeSymbol, probeCompetingLiveSession } from "./probeCompetingLiveSession.js";
import { blockedAfterReloginMessage, blockedRestartDeferredMessage, competingLiveSessionSurvivedRestart, reportCompetingLiveSession } from "../lib/competingLiveSessionAlert.js";
import { reportPositionReconciliation, type PositionReconciliationResult } from "../lib/positionReconciliationAlert.js";

// Confirmed 2026-08-27: reqHistoricalData can silently hang (no data, no
// error event — just a timeout) while the connection handshake itself and
// every other IBKR call stay healthy. This is exactly what let the 9PM UTC
// daily-market-data job fail 100% of tickers for 4+ straight days without
// this health check ever noticing, since it only checked the handshake.
// SPY is used as a fixed, always-listed probe symbol independent of
// whatever's on the shortlist.
const HISTORICAL_DATA_PROBE_SYMBOL = liveDataProbeSymbol;

interface HistoricalDataCheckResult {
  healthy: boolean;
  errorMessage: string | null;
}

// errorMessage is surfaced to the caller now (previously discarded via a
// bare `catch { return false }`) — see the 2026-09-10 incident note on
// isCompetingSessionHistoricalDataError below for why that swallowed error
// text turned out to matter: the real IBKR reason never reached
// job_runs.error_message or the Telegram alert, which is how "reqHistoricalData
// was silently hung" made it into a notification even though the failure was
// a specific, named IBKR error the whole time.
export async function checkHistoricalData(connection: IbkrConnection): Promise<HistoricalDataCheckResult> {
  try {
    await lookupLatestDailyBar(connection, HISTORICAL_DATA_PROBE_SYMBOL, 999_001);
    return { healthy: true, errorMessage: null };
  } catch (error) {
    return { healthy: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Confirmed live 2026-09-10 (see PROGRESS.md): IBKR's Historical Market Data
// farm ties itself to a single session IP per account and rejects
// reqHistoricalData with this exact code-162 message when some other
// connection under the same paper account (johndom873 — same account as the
// code-10197 competing-live-session check below, different subsystem) is
// seen from a different IP. Not a Gateway problem: a restart re-establishes
// the connection from the same VPS IP, so it fixes nothing here — two
// consecutive restarts both hit the identical error immediately after
// reconnecting, and it cleared on its own ~20 minutes later with no further
// restart. Matched on the formatted error text from checkHistoricalData
// above (`Historical data error for SPY (code 162): ...different IP
// address`) rather than a raw IBKR error code, since IBKR reuses code 162
// for unrelated messages too (e.g. "API scanner subscription cancelled").
export function isCompetingSessionHistoricalDataError(errorMessage: string): boolean {
  return errorMessage.includes("(code 162)") && errorMessage.includes("different IP address");
}

// Evidence 2026-09-24 (job_runs since 2026-08-24): the SPY probe's "Historical
// data timeout" fired 7 times in 3,648 runs, and the two most recent both
// landed while a scheduled option scan was mid-run on the
// same login — the check then restarted the Gateway underneath that scan and
// reported "restart didn't recover it" because the load was still there.
// So a probe timeout is not restart-worthy on its own. A restart is only
// justified when (a) no other job is running right now and (b) the previous
// check's probe also failed — a single failure is recorded in job_runs.details
// (probe.failed) and waits for the next run to confirm.
const runningJobLookbackMs = 2 * 60 * 60 * 1000;

const historicalDataRecoveredMessage = "ℹ️ IBKR Historical Data initialised (Gateway restarted after the SPY probe failed twice; probe OK now).";

export async function findOtherRunningJobName(): Promise<string | null> {
  const row = await db("job_runs")
    .where({ status: "running" })
    .whereNot({ job_name: "ibkr_health_check" })
    .where("started_at", ">", new Date(Date.now() - runningJobLookbackMs))
    .orderBy("started_at", "desc")
    .first("job_name");
  return row?.job_name ?? null;
}

export async function previousHealthCheckProbeFailed(): Promise<boolean> {
  // The current run's own row is already in job_runs as "running" (runJob inserts it first): skip it, or this never sees a prior failure.
  const row = await db("job_runs").where({ job_name: "ibkr_health_check" }).whereNot({ status: "running" }).orderBy("started_at", "desc").first("details", "error_message");
  if (!row) return false;
  const probe = (row.details as { probe?: { failed?: boolean } } | null)?.probe;
  return probe?.failed === true || String(row.error_message ?? "").includes("reqHistoricalData failed");
}

// Once a session restart has not brought historical data back on live, more session restarts do not either (2026-11-03:
// 44 of them over 12 hours; a fresh login fixed it). Live cannot log in again by itself (the phone approves it), so the
// check stops restarting and keeps failing with this text until the probe passes. A constant text, so the throttled alert
// goes out once and then reminds hourly. Paper is left as it is: its recovery falls back to a cold restart, a fresh login.
export const liveFreshLoginNeededMessage =
  "IBKR historical data is still down after a Gateway session restart: the live Gateway needs a fresh login (a cold restart of its container on the VPS, approved on the phone). Not restarting again until the SPY probe passes.";

export async function previousHealthCheckFoundFreshLoginNeeded(): Promise<boolean> {
  // Skips the current run's own "running" row, as previousHealthCheckProbeFailed does.
  const row = await db("job_runs").where({ job_name: "ibkr_health_check" }).whereNot({ status: "running" }).orderBy("started_at", "desc").first("details", "error_message");
  if (!row) return false;
  const probe = (row.details as { probe?: { freshLoginNeeded?: boolean } } | null)?.probe;
  return probe?.freshLoginNeeded === true || String(row.error_message ?? "").includes("restart didn't recover reqHistoricalData");
}

function requireEnvironmentVariable(variableName: string): string {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return value;
}

// IBKR's farm status ("HMDS data farm connection is broken/OK", 2105/2106, ...) is captured into job_runs.details on
// every connection this job opens (initial + any post-restart reconnect), so a recurrence leaves a farm-status trail
// instead of another guess. They arrive with the handshake, so connectToIbkrGateway hands them over (onNotice). Ruled
// out 2026-09-09: the "settings may be corrupted, recovering from backup" dialog every restart's captured logs show is
// NOT diagnostic — it appears identically on the routine scheduled daily auto-restart too, unrelated to any hang.
export type FarmStatusMessage = IbkrConnectionNotice;

// Checks Gateway health by actually completing an IBKR API handshake
// (connectToIbkrGateway's nextValidId round-trip), not just a TCP probe.
// A container can be "Up" with its process logged into the UI while the
// API socket behind it refuses every connection (seen 2026-08-20/21, ~16h
// outage) — a TCP-level check on the VPS side can't tell those apart, since
// the container's socat proxy accepts the TCP connection regardless of
// whether the real Gateway API is listening behind it. Keeps the connection
// open on success (rather than immediately disconnecting) so the caller can
// reuse it for the position-reconciliation check below without a second
// connect/disconnect round-trip.
//
// farmStatusMessages is caller-owned, not module-level — this job also runs
// on-demand from System Health's button on the long-lived web dyno, where a
// module-level buffer would leak across invocations and mix one run's farm
// events into another's job_runs row.
export type ConnectAttempt = { connection: IbkrConnection; errorMessage: null } | { connection: null; errorMessage: string };

export async function tryConnect(farmStatusMessages: FarmStatusMessage[]): Promise<ConnectAttempt> {
  try {
    const connection = await connectToIbkrGateway({ onNotice: (notice) => farmStatusMessages.push(notice) });
    return { connection, errorMessage: null };
  } catch (error) {
    return { connection: null, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// One failed handshake from Heroku is not proof the Gateway is down: the VPS's own handshake and the long-lived web/agent
// connections can all be fine while this one-off connect times out, and a restart drops every one of those connections.
// So an unreachable Gateway gets one more handshake before it is restarted.
export const unreachableRetryDelayMs = 10_000;
// gateway-control.sh reports the Gateway back once the API sends its version bytes, which comes before a full handshake
// (nextValidId) works again, so a single reconnect right after the script can fail on a Gateway that recovers seconds later.
export const postRestartConnectAttempts = 3;
export const postRestartConnectRetryDelayMs = 10_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Detection only, never throws — a reconciliation problem is a data
 * finding, not a job execution failure: the job always succeeds and reports
 * it via `notify`. If the check itself
 * blows up (e.g. a query error), that's reported as a finding too rather
 * than failing the whole health-check job over it.
 */
/** Starts the one "problem" recorded when reconciliation could not run at all (not a discrepancy). */
export const reconciliationRunFailedPrefix = "Reconciliation check itself failed";

export async function runReconciliationSafely(connection: IbkrConnection): Promise<string[]> {
  try {
    return await checkPositionReconciliation(connection.ib);
  } catch (error) {
    return [`${reconciliationRunFailedPrefix}: ${error instanceof Error ? error.message : error}`];
  }
}

export async function previousHealthCheckCouldNotReconcile(): Promise<boolean> {
  // Skips the current run's own "running" row, as previousHealthCheckProbeFailed does.
  const row = await db("job_runs").where({ job_name: "ibkr_health_check" }).whereNot({ status: "running" }).orderBy("started_at", "desc").first("details", "error_message");
  const problems = (row?.details as { reconciliationProblems?: unknown } | null | undefined)?.reconciliationProblems;
  return Array.isArray(problems) && problems.some((problem) => String(problem).startsWith(reconciliationRunFailedPrefix));
}

export async function classifyReconciliationProblems(problems: string[]): Promise<PositionReconciliationResult> {
  const runFailure = problems.find((problem) => problem.startsWith(reconciliationRunFailedPrefix));
  if (runFailure) {
    return { kind: "couldNotRun", reason: runFailure.slice(reconciliationRunFailedPrefix.length).replace(/^:\s*/, ""), previousRunAlsoCouldNotRun: await previousHealthCheckCouldNotReconcile() };
  }
  return problems.length > 0 ? { kind: "mismatches", mismatches: problems } : { kind: "clean" };
}

// Runs every ~10 min, so an IBKR outage (e.g. weekend maintenance) would
// otherwise send a failure message every run. Alert on the first failure,
// then remind hourly; recovery is announced by runJob's failure-streak logic.
const healthCheckFailureReminderIntervalMs = 60 * 60_000;

/**
 * Runs a real IBKR API connectivity check and, only if that fails, asks the
 * VPS to restart the Gateway container and rechecks — then, either way,
 * runs checkPositionReconciliation.ts (added 2026-08-25, see that file for
 * why) against the same connection before disconnecting. Also checks the
 * VPS worker's systemd status every run (added 2026-08-25, see
 * checkWorkerOnVps.ts for why this can't be gated the same way the Gateway
 * check is) and auto-restarts it if inactive. Logs the result via runJob
 * (job_runs), same as the other scheduled jobs — see checkIbkrHealth.ts's
 * original comment, which predates job_runs existing. Shared by the Heroku
 * Scheduler script and System Health's on-demand "Run Health Check Now"
 * button, so both show up in the same job history instead of the scheduled
 * runs being invisible to that screen.
 */
export interface IbkrHealthCheckOptions {
  /**
   * False for the System Health button during market hours (approved
   * 2026-09-24): a Gateway restart disconnects the order worker for a minute
   * or more, so a person clicking mid-session gets a report instead. The
   * scheduled check keeps its own restart policy.
   */
  allowGatewayRestart?: boolean;
  triggeredBy?: "scheduler" | "manual";
  triggeredByUserId?: string;
}

export async function runIbkrHealthCheckJob(options: IbkrHealthCheckOptions = {}): Promise<void> {
  const allowGatewayRestart = options.allowGatewayRestart ?? true;
  await runJob("ibkr_health_check", async () => {
    const notifications: string[] = [];
    const farmStatusMessages: FarmStatusMessage[] = [];

    // Independent checks (they only read the database), run FIRST: everything after this can throw during an IBKR
    // outage or a VPS problem, and these two must not go blind exactly then.
    const marketQuoteLoopProblem = await reportMarketQuoteLoopLiveness().catch((error) => `Market quote loop liveness check itself failed: ${error instanceof Error ? error.message : error}`);
    const opsMonitorProblem = await reportOpsMonitorLiveness().catch((error) => `Ops monitor liveness check itself failed: ${error instanceof Error ? error.message : error}`);

    // The worker heartbeat needs the systemd probe below to tell "hung" from "stopped" (and to give a just-restarted worker
    // time to beat), so it runs after the probe; the finally guarantees it still runs when an earlier IBKR step throws,
    // reporting the service state as unknown in that case.
    let workerProbe: { active: boolean; restarted: boolean } | null = null;
    let workerHeartbeatProblem: string | null | undefined;
    const checkWorkerHeartbeat = async (): Promise<void> => {
      if (workerHeartbeatProblem !== undefined) return;
      workerHeartbeatProblem = await reportWorkerHeartbeat({ serviceActive: workerProbe ? workerProbe.active : null, restartedJustNow: workerProbe?.restarted ?? false }).catch((error) => `Worker heartbeat check itself failed: ${error instanceof Error ? error.message : error}`);
    };

    // Every Gateway connection this run opens, and which of them it has closed. The normal paths close their own, but a later step
    // that throws (the VPS worker check, the competing-session probe) would otherwise leave the last one open: the finally closes
    // whatever is still open.
    const openedConnections: IbkrConnection[] = [];
    const closedConnections = new Set<IbkrConnection>();
    function closeConnection(connection: IbkrConnection): void {
      closedConnections.add(connection);
      connection.disconnect();
    }
    // Every failed handshake's error, labelled by attempt: kept in details on success and appended to the failure message
    // after the script output (past the first "): ", so the Telegram text stays constant and the throttle holds).
    const handshakeErrors: string[] = [];
    async function connectTracked(attemptLabel: string): Promise<IbkrConnection | null> {
      const attempt = await tryConnect(farmStatusMessages);
      if (!attempt.connection) {
        handshakeErrors.push(`${attemptLabel}: ${attempt.errorMessage}`);
        return null;
      }
      openedConnections.push(attempt.connection);
      return attempt.connection;
    }

    // What the run has found so far: returned in details on success, and kept with a failure too (JobFailedWithDetailsError).
    let gatewayOutput = "healthy";
    let probe: { failed: boolean; reason: string | null; restarted: boolean; freshLoginNeeded?: boolean } = { failed: false, reason: null, restarted: false };
    let workerCheck: { active: boolean; restarted: boolean } | null = null;
    let competingLiveSession: Awaited<ReturnType<typeof probeCompetingLiveSession>> | null = null;
    let problems: string[] | null = null;
    const buildDetails = () => ({
      output: gatewayOutput,
      handshakeErrors,
      probe,
      worker: workerCheck ? { active: workerCheck.active, restarted: workerCheck.restarted } : null,
      reconciliationProblems: problems,
      competingLiveSession,
      marketQuoteLoopProblem,
      opsMonitorProblem,
      workerHeartbeatProblem,
      farmStatusMessages,
    });

    try {
    let connection = await connectTracked("first");
    if (!connection) {
      await wait(unreachableRetryDelayMs);
      connection = await connectTracked("retry");
      if (connection) gatewayOutput = `healthy (first handshake failed, retry ok: ${handshakeErrors[0]})`;
    }

    async function restartAndReconnect(problemDescription: string, recoveredMessage?: string): Promise<IbkrConnection> {
      if (!allowGatewayRestart) {
        throw new Error(`IBKR Gateway ${problemDescription} — not restarted: restarts are not allowed from the manual check while the market is open (the scheduled check will handle it).`);
      }
      const sshPrivateKey = Buffer.from(requireEnvironmentVariable("IBKR_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64"), "base64");

      const result = await restartIbkrGatewayOnVps({
        sshHost: environment.ibkrTunnelSshHost,
        sshPort: environment.ibkrTunnelSshPort,
        sshUsername: environment.ibkrTunnelSshUsername,
        sshPrivateKey,
      });

      let reconnected: IbkrConnection | null = null;
      for (let attempt = 1; attempt <= postRestartConnectAttempts && !reconnected; attempt++) {
        if (attempt > 1) await wait(postRestartConnectRetryDelayMs);
        reconnected = await connectTracked(`after restart ${attempt}/${postRestartConnectAttempts}`);
      }
      if (!reconnected) {
        const manualLoginHeadline = describeLiveGatewayManualLoginHeadline(parseGatewayControlResultKind(result.output), environment.ibkrTradingMode);
        const diagnosis = manualLoginHeadline ?? `IBKR Gateway ${problemDescription} and restart didn't recover it`;
        throw new Error(`${diagnosis} (script exit ${result.exitCode}): ${result.output.trim()}\nHandshake errors: ${handshakeErrors.join("; ")}`);
      }

      // Previously this declared victory on the handshake alone — but the
      // handshake was never what broke in the reqHistoricalData-hang case, so
      // that "recovery confirmed" claim was never actually checked against
      // the thing that failed. Re-probing here means a restart that doesn't
      // actually fix reqHistoricalData now surfaces as a real job failure
      // instead of a false all-clear.
      const reprobe = await checkHistoricalData(reconnected);
      if (!reprobe.healthy) {
        // Same non-restart-fixable condition as the pre-restart check below
        // — a restart genuinely did nothing for it (that's how this branch
        // was found), so treat it the same way: notify, don't fail the job.
        if (reprobe.errorMessage && isCompetingSessionHistoricalDataError(reprobe.errorMessage)) {
          gatewayOutput = `unhealthy (${problemDescription}), restarted — handshake recovered, but historical data is still blocked by a competing session (unrelated to the restart)`;
          notifications.push(
            `⚠️ IBKR Gateway ${problemDescription} — restarted, handshake recovered, but reqHistoricalData is still blocked: IBKR code 162, "Trading TWS session is connected from a different IP address." ` +
              "Someone else is likely logged into johndom873 elsewhere. Not a Gateway problem and a restart won't fix it — expect it to clear on its own once that session ends.",
          );
          return reconnected;
        }

        closeConnection(reconnected);
        throw new Error(
          `IBKR Gateway ${problemDescription} and restart didn't recover reqHistoricalData either (${reprobe.errorMessage ?? "unknown error"}) (script exit ${result.exitCode}): ${result.output.trim()}`,
        );
      }

      gatewayOutput = `unhealthy (${problemDescription}), restarted, recovered — restart script output: ${result.output.trim()}`;
      notifications.push(recoveredMessage ?? `⚠️ IBKR Gateway ${problemDescription} — restarted, recovery confirmed via a real handshake and a reqHistoricalData probe.`);
      return reconnected;
    }

    if (!connection) {
      connection = await restartAndReconnect("was unreachable");
    } else {
      const historicalDataCheck = await checkHistoricalData(connection);
      if (!historicalDataCheck.healthy) {
        // Confirmed 2026-09-10 a Gateway restart doesn't fix this specific
        // failure (see isCompetingSessionHistoricalDataError above) — so
        // unlike every other reqHistoricalData failure here, this one skips
        // the restart entirely and is reported as a notify-only finding,
        // the same pattern as the code-10197 competing-session check below.
        if (historicalDataCheck.errorMessage && isCompetingSessionHistoricalDataError(historicalDataCheck.errorMessage)) {
          notifications.push(
            '⚠️ Historical data is currently blocked: IBKR code 162, "Trading TWS session is connected from a different IP address." ' +
              "Someone else is likely logged into johndom873 elsewhere. Not a Gateway problem and a restart won't fix it — expect it to clear on its own once that session ends.",
          );
        } else {
          const reason = historicalDataCheck.errorMessage ?? "unknown error";
          if (environment.ibkrTradingMode === "live" && (await previousHealthCheckFoundFreshLoginNeeded())) {
            probe = { failed: true, reason, restarted: false, freshLoginNeeded: true };
            gatewayOutput = `healthy handshake; reqHistoricalData probe failed (${reason}) after a session restart already failed to recover it — waiting for a fresh login`;
            throw new Error(liveFreshLoginNeededMessage);
          }
          const otherRunningJob = await findOtherRunningJobName();
          const previousProbeFailed = await previousHealthCheckProbeFailed();
          if (otherRunningJob) {
            probe = { failed: true, reason, restarted: false };
            gatewayOutput = `healthy handshake; reqHistoricalData probe failed (${reason}) while ${otherRunningJob} is running — not restarting under load`;
          } else if (!previousProbeFailed) {
            probe = { failed: true, reason, restarted: false };
            gatewayOutput = `healthy handshake; reqHistoricalData probe failed once (${reason}) — no restart until it fails on the next run too`;
          } else {
            probe = { failed: true, reason, restarted: true };
            closeConnection(connection);
            // Happens daily around 12:20/12:40 UTC and a restart fixes it, so a confirmed recovery is info, not a warning.
            connection = await restartAndReconnect(
              `handshake succeeded but reqHistoricalData failed on two consecutive runs (${reason})`,
              historicalDataRecoveredMessage,
            );
          }
        }
      }
    }

    const workerSshPrivateKey = Buffer.from(requireEnvironmentVariable("IORIO_WORKER_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64"), "base64");
    const workerResult = await checkWorkerOnVps({
      sshHost: environment.ibkrTunnelSshHost,
      sshPort: environment.ibkrTunnelSshPort,
      sshUsername: environment.ibkrTunnelSshUsername,
      sshPrivateKey: workerSshPrivateKey,
    });
    workerProbe = workerResult;
    workerCheck = workerResult;

    if (workerResult.restarted) {
      if (!workerResult.active) {
        closeConnection(connection);
        throw new Error(`iorio-worker.service was inactive and the restart didn't recover it: ${workerResult.output.trim()}`);
      }
      notifications.push(`⚠️ iorio-worker.service was inactive — restarted successfully, now active.`);
    }

    // IBKR 10197 ("competing live session"): usually a stale Gateway session that only a fresh login
    // clears (probeCompetingLiveSession.ts), so restart once per episode; if 10197 survives the fresh
    // login, a real session on the live username is the likelier cause and the alert says so instead of
    // restarting again. Alerts are state-based (once, hourly reminders, "flowing again").
    competingLiveSession = await probeCompetingLiveSession(connection.ib, 999_002, HISTORICAL_DATA_PROBE_SYMBOL);
    let blockedMessage = blockedAfterReloginMessage;
    let recoveredByRestart = false;
    if (competingLiveSession === "blocked" && !(await competingLiveSessionSurvivedRestart())) {
      const otherRunningJob = allowGatewayRestart ? await findOtherRunningJobName() : null;
      if (!allowGatewayRestart) {
        blockedMessage = blockedRestartDeferredMessage("restarts aren't allowed from the manual check while the market is open; the scheduled check will restart it");
      } else if (otherRunningJob) {
        blockedMessage = blockedRestartDeferredMessage(`${otherRunningJob} is running; the next check restarts the Gateway once it finishes`);
      } else {
        closeConnection(connection);
        connection = await restartAndReconnect("was refused real-time market data (IBKR 10197)");
        competingLiveSession = await probeCompetingLiveSession(connection.ib, 999_003, HISTORICAL_DATA_PROBE_SYMBOL);
        recoveredByRestart = competingLiveSession === "flowing";
      }
    }
    const sentRecovery = await reportCompetingLiveSession(competingLiveSession, blockedMessage).catch((error) => {
      console.warn(`competing live session alert failed: ${error instanceof Error ? error.message : error}`);
      return false;
    });
    if (recoveredByRestart && !sentRecovery) notifications.push("✅ Real-time market data is flowing again after the Gateway re-login (IBKR 10197: stale session).");

    const reconciliationProblems = await runReconciliationSafely(connection);
    problems = reconciliationProblems;
    closeConnection(connection);
    await classifyReconciliationProblems(reconciliationProblems)
      .then(reportPositionReconciliation)
      .catch((error) => console.warn(`position reconciliation alert failed: ${error instanceof Error ? error.message : error}`));

    await checkWorkerHeartbeat();
    return {
      details: buildDetails(),
      notify: notifications.length > 0 ? notifications.join("\n\n") : undefined,
    };
    } catch (error) {
      await checkWorkerHeartbeat();
      throw new JobFailedWithDetailsError(error instanceof Error ? describeThrown(error) : String(error), buildDetails(), { cause: error });
    } finally {
      for (const opened of openedConnections) {
        if (closedConnections.has(opened)) continue;
        try {
          opened.disconnect();
        } catch (error) {
          console.warn(`Health check: could not close a Gateway connection: ${error instanceof Error ? error.message : error}`);
        }
      }
      await checkWorkerHeartbeat();
    }
  }, { failureAlertReminderIntervalMs: healthCheckFailureReminderIntervalMs, triggeredBy: options.triggeredBy, triggeredByUserId: options.triggeredByUserId });
}
