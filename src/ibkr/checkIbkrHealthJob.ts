import { runVpsHealthcheck } from "./runVpsHealthcheck.js";
import { connectToIbkrGateway, type IbkrConnection } from "./connectIbkr.js";
import { checkPositionReconciliation } from "./checkPositionReconciliation.js";
import { runJob } from "../lib/runJob.js";
import { environment } from "../config/env.js";

function requireEnvironmentVariable(variableName: string): string {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return value;
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
async function tryConnect(): Promise<IbkrConnection | null> {
  try {
    return await connectToIbkrGateway();
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
 * why) against the same connection before disconnecting. Logs the result
 * via runJob (job_runs), same as the other scheduled jobs — see
 * checkIbkrHealth.ts's original comment, which predates job_runs existing.
 * Shared by the Heroku Scheduler script and System Health's on-demand "Run
 * Health Check Now" button, so both show up in the same job history instead
 * of the scheduled runs being invisible to that screen.
 */
export async function runIbkrHealthCheckJob(): Promise<void> {
  await runJob("ibkr_health_check", async () => {
    let connection = await tryConnect();
    let output = "healthy";

    if (!connection) {
      const sshPrivateKey = Buffer.from(requireEnvironmentVariable("IBKR_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64"), "base64");

      const result = await runVpsHealthcheck({
        sshHost: environment.ibkrTunnelSshHost,
        sshPort: environment.ibkrTunnelSshPort,
        sshUsername: environment.ibkrTunnelSshUsername,
        sshPrivateKey,
      });

      connection = await tryConnect();
      if (!connection) {
        throw new Error(`IBKR Gateway unreachable and restart didn't recover it (script exit ${result.exitCode}): ${result.output.trim()}`);
      }
      output = `unhealthy, restarted, recovered — restart script output: ${result.output.trim()}`;
    }

    const problems = await runReconciliationSafely(connection);
    connection.disconnect();

    return {
      details: { output, reconciliationProblems: problems },
      notify: problems.length > 0 ? reconciliationNotifyMessage(problems) : undefined,
    };
  });
}
