import { EventName, MarketDataType, Stock } from "@stoqey/ib";
import { restartIbkrGatewayOnVps } from "./restartIbkrGatewayOnVps.js";
import { checkWorkerOnVps } from "./checkWorkerOnVps.js";
import { connectToIbkrGateway, type IbkrConnection } from "./connectIbkr.js";
import { checkPositionReconciliation } from "./checkPositionReconciliation.js";
import { lookupLatestDailyBar } from "./fetchTickerOverview.js";
import { runJob } from "../lib/runJob.js";
import { environment } from "../config/env.js";
import { db } from "../db/connection.js";
import { reportDaySignalsLoopLiveness } from "../lib/daySignalsLiveness.js";

// Confirmed 2026-08-27: reqHistoricalData can silently hang (no data, no
// error event — just a timeout) while the connection handshake itself and
// every other IBKR call stay healthy. This is exactly what let the 9PM UTC
// daily-market-data job fail 100% of tickers for 4+ straight days without
// this health check ever noticing, since it only checked the handshake.
// SPY is used as a fixed, always-listed probe symbol independent of
// whatever's on the shortlist.
const HISTORICAL_DATA_PROBE_SYMBOL = "SPY";

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
async function checkHistoricalData(connection: IbkrConnection): Promise<HistoricalDataCheckResult> {
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
function isCompetingSessionHistoricalDataError(errorMessage: string): boolean {
  return errorMessage.includes("(code 162)") && errorMessage.includes("different IP address");
}

// Confirmed 2026-08-31 (see PROGRESS.md): IBKR's shared-market-data paper
// account cannot receive real-time quotes while its own live username
// (johndom873) has an active session anywhere (Client Portal/TWS/mobile) —
// error 10197 on every market-data request, with the Gateway connection
// itself staying up and healthy throughout, so nothing else here would ever
// catch it. Restarting the Gateway does not fix this — it's a live-session
// state issue, not a Gateway problem — so this is reported as a notify-only
// finding, the same pattern as position-reconciliation problems below.
async function competingLiveSessionIsBlockingData(connection: IbkrConnection): Promise<boolean> {
  return new Promise((resolve) => {
    const reqId = 999_002;
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 5_000);

    function onError(_error: Error, code: number, id: number) {
      if (id !== reqId || code !== 10197) return;
      cleanup();
      resolve(true);
    }
    function onMarketDataType(id: number) {
      if (id !== reqId) return;
      cleanup();
      resolve(false);
    }
    function cleanup() {
      clearTimeout(timer);
      connection.ib.removeListener(EventName.error, onError);
      connection.ib.removeListener(EventName.marketDataType, onMarketDataType);
      connection.ib.cancelMktData(reqId);
    }

    connection.ib.on(EventName.error, onError);
    connection.ib.on(EventName.marketDataType, onMarketDataType);
    connection.ib.reqMarketDataType(MarketDataType.REALTIME);
    connection.ib.reqMktData(reqId, new Stock(HISTORICAL_DATA_PROBE_SYMBOL, "SMART", "USD"), "", false, false);
  });
}

// Evidence 2026-09-24 (job_runs since 2026-08-24): the SPY probe's "Historical
// data timeout" fired 7 times in 3,648 runs, and the two most recent both
// landed while the option-chain capture / trade-alert scan was mid-run on the
// same login — the check then restarted the Gateway underneath that scan and
// reported "restart didn't recover it" because the load was still there.
// So a probe timeout is not restart-worthy on its own. A restart is only
// justified when (a) no other job is running right now and (b) the previous
// check's probe also failed — a single failure is recorded in job_runs.details
// (probe.failed) and waits for the next run to confirm.
const runningJobLookbackMs = 2 * 60 * 60 * 1000;

async function findOtherRunningJobName(): Promise<string | null> {
  const row = await db("job_runs")
    .where({ status: "running" })
    .whereNot({ job_name: "ibkr_health_check" })
    .where("started_at", ">", new Date(Date.now() - runningJobLookbackMs))
    .orderBy("started_at", "desc")
    .first("job_name");
  return row?.job_name ?? null;
}

async function previousHealthCheckProbeFailed(): Promise<boolean> {
  const row = await db("job_runs").where({ job_name: "ibkr_health_check" }).orderBy("started_at", "desc").first("details", "error_message");
  if (!row) return false;
  const probe = (row.details as { probe?: { failed?: boolean } } | null)?.probe;
  return probe?.failed === true || String(row.error_message ?? "").includes("reqHistoricalData failed");
}

function requireEnvironmentVariable(variableName: string): string {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return value;
}

// Investigated 2026-09-09 (weeks-long recurrence of the reqHistoricalData
// hang below): IBKR broadcasts market-data-farm connectivity state (e.g.
// "HMDS data farm connection is broken/OK") as informational error events on
// reqId -1, which connectToIbkrGateway already logs via console.log — but
// Heroku's log buffer is too short-lived to have this by the time anyone
// looks. Captured here into job_runs.details instead, on every connection
// this job opens (initial + any post-restart reconnect), so the next
// recurrence gives a real farm-status trail instead of another guess. Ruled
// out 2026-09-09: the "settings may be corrupted, recovering from backup"
// dialog every restart's captured logs show is NOT diagnostic — it appears
// identically on the routine scheduled daily auto-restart too, unrelated to
// any hang.
interface FarmStatusMessage {
  at: string;
  code: number;
  message: string;
}

function captureFarmStatusMessages(connection: IbkrConnection, into: FarmStatusMessage[]): void {
  connection.ib.on(EventName.error, (error: Error, code: number, reqId: number) => {
    if (reqId !== -1) return;
    into.push({ at: new Date().toISOString(), code, message: error.message });
  });
}

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
async function tryConnect(farmStatusMessages: FarmStatusMessage[]): Promise<IbkrConnection | null> {
  try {
    const connection = await connectToIbkrGateway();
    captureFarmStatusMessages(connection, farmStatusMessages);
    return connection;
  } catch {
    return null;
  }
}

function reconciliationNotifyMessage(problems: string[]): string {
  return `⚠️ Position reconciliation: ${problems.length} discrepancy(ies) between IBKR and local data —\n${problems.map((p) => `• ${p}`).join("\n")}`;
}

/**
 * Detection only, never throws — a reconciliation problem is a data
 * finding, not a job execution failure, matching the watchdog's convention
 * of always succeeding and reporting via `notify`. If the check itself
 * blows up (e.g. a query error), that's reported as a finding too rather
 * than failing the whole health-check job over it.
 */
async function runReconciliationSafely(connection: IbkrConnection): Promise<string[]> {
  try {
    return await checkPositionReconciliation(connection.ib);
  } catch (error) {
    return [`Reconciliation check itself failed: ${error instanceof Error ? error.message : error}`];
  }
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

    let connection = await tryConnect(farmStatusMessages);
    let gatewayOutput = "healthy";
    let probe: { failed: boolean; reason: string | null; restarted: boolean } = { failed: false, reason: null, restarted: false };

    async function restartAndReconnect(problemDescription: string): Promise<IbkrConnection> {
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

      const reconnected = await tryConnect(farmStatusMessages);
      if (!reconnected) {
        throw new Error(`IBKR Gateway ${problemDescription} and restart didn't recover it (script exit ${result.exitCode}): ${result.output.trim()}`);
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

        reconnected.disconnect();
        throw new Error(
          `IBKR Gateway ${problemDescription} and restart didn't recover reqHistoricalData either (${reprobe.errorMessage ?? "unknown error"}) (script exit ${result.exitCode}): ${result.output.trim()}`,
        );
      }

      gatewayOutput = `unhealthy (${problemDescription}), restarted, recovered — restart script output: ${result.output.trim()}`;
      notifications.push(`⚠️ IBKR Gateway ${problemDescription} — restarted, recovery confirmed via a real handshake and a reqHistoricalData probe.`);
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
            connection.disconnect();
            connection = await restartAndReconnect(`handshake succeeded but reqHistoricalData failed on two consecutive runs (${reason})`);
          }
        }
      }
    }

    const workerSshPrivateKey = Buffer.from(requireEnvironmentVariable("IORIO_WORKER_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64"), "base64");
    const workerCheck = await checkWorkerOnVps({
      sshHost: environment.ibkrTunnelSshHost,
      sshPort: environment.ibkrTunnelSshPort,
      sshUsername: environment.ibkrTunnelSshUsername,
      sshPrivateKey: workerSshPrivateKey,
    });

    if (workerCheck.restarted) {
      if (!workerCheck.active) {
        connection.disconnect();
        throw new Error(`iorio-worker.service was inactive and the restart didn't recover it: ${workerCheck.output.trim()}`);
      }
      notifications.push(`⚠️ iorio-worker.service was inactive — restarted successfully, now active.`);
    }

    const competingLiveSession = await competingLiveSessionIsBlockingData(connection);
    if (competingLiveSession) {
      notifications.push(
        "⚠️ Real-time market data is currently blocked — IBKR error 10197 (competing live session). " +
          "Someone is likely logged into johndom873 in Client Portal/TWS/mobile; ask them to log out. " +
          "Not a Gateway problem, won't be fixed by a restart.",
      );
    }

    const problems = await runReconciliationSafely(connection);
    connection.disconnect();

    if (problems.length > 0) {
      notifications.push(reconciliationNotifyMessage(problems));
    }

    // Alerts on its own (state-based, hourly reminders) rather than through this
    // job's per-run notify, which would repeat every 10 minutes while it is down.
    const daySignalsProblem = await reportDaySignalsLoopLiveness().catch((error) => `Day Signals liveness check itself failed: ${error instanceof Error ? error.message : error}`);

    return {
      details: {
        output: gatewayOutput,
        probe,
        worker: { active: workerCheck.active, restarted: workerCheck.restarted },
        reconciliationProblems: problems,
        competingLiveSession,
        daySignalsProblem,
        farmStatusMessages,
      },
      notify: notifications.length > 0 ? notifications.join("\n\n") : undefined,
    };
  }, { failureAlertReminderIntervalMs: healthCheckFailureReminderIntervalMs, triggeredBy: options.triggeredBy, triggeredByUserId: options.triggeredByUserId });
}
