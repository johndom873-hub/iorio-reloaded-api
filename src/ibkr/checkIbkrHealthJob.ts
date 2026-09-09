import { EventName, MarketDataType, Stock } from "@stoqey/ib";
import { restartIbkrGatewayOnVps } from "./restartIbkrGatewayOnVps.js";
import { checkWorkerOnVps } from "./checkWorkerOnVps.js";
import { connectToIbkrGateway, type IbkrConnection } from "./connectIbkr.js";
import { checkPositionReconciliation } from "./checkPositionReconciliation.js";
import { lookupLatestDailyBar } from "./fetchTickerOverview.js";
import { runJob } from "../lib/runJob.js";
import { environment } from "../config/env.js";

// Confirmed 2026-08-27: reqHistoricalData can silently hang (no data, no
// error event — just a timeout) while the connection handshake itself and
// every other IBKR call stay healthy. This is exactly what let the 9PM UTC
// daily-market-data job fail 100% of tickers for 4+ straight days without
// this health check ever noticing, since it only checked the handshake.
// SPY is used as a fixed, always-listed probe symbol independent of
// whatever's on the shortlist.
const HISTORICAL_DATA_PROBE_SYMBOL = "SPY";

async function historicalDataIsHealthy(connection: IbkrConnection): Promise<boolean> {
  try {
    await lookupLatestDailyBar(connection, HISTORICAL_DATA_PROBE_SYMBOL, 999_001);
    return true;
  } catch {
    return false;
  }
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
export async function runIbkrHealthCheckJob(): Promise<void> {
  await runJob("ibkr_health_check", async () => {
    const notifications: string[] = [];
    const farmStatusMessages: FarmStatusMessage[] = [];

    let connection = await tryConnect(farmStatusMessages);
    let gatewayOutput = "healthy";

    async function restartAndReconnect(problemDescription: string): Promise<IbkrConnection> {
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
      if (!(await historicalDataIsHealthy(reconnected))) {
        reconnected.disconnect();
        throw new Error(
          `IBKR Gateway ${problemDescription} and restart didn't recover reqHistoricalData either (script exit ${result.exitCode}): ${result.output.trim()}`,
        );
      }

      gatewayOutput = `unhealthy (${problemDescription}), restarted, recovered — restart script output: ${result.output.trim()}`;
      notifications.push(`⚠️ IBKR Gateway ${problemDescription} — restarted, recovery confirmed via a real handshake and a reqHistoricalData probe.`);
      return reconnected;
    }

    if (!connection) {
      connection = await restartAndReconnect("was unreachable");
    } else if (!(await historicalDataIsHealthy(connection))) {
      connection.disconnect();
      connection = await restartAndReconnect("handshake succeeded but reqHistoricalData was silently hung");
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

    return {
      details: {
        output: gatewayOutput,
        worker: { active: workerCheck.active, restarted: workerCheck.restarted },
        reconciliationProblems: problems,
        competingLiveSession,
        farmStatusMessages,
      },
      notify: notifications.length > 0 ? notifications.join("\n\n") : undefined,
    };
  });
}
