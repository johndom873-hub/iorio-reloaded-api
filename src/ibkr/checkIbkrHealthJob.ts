import { runVpsHealthcheck } from "./runVpsHealthcheck.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
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
// whether the real Gateway API is listening behind it.
async function isGatewayReachable(): Promise<boolean> {
  try {
    const connection = await connectToIbkrGateway();
    connection.disconnect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a real IBKR API connectivity check and, only if that fails, asks the
 * VPS to restart the Gateway container and rechecks. Logs the result via
 * runJob (job_runs), same as the other 3 scheduled jobs — see
 * checkIbkrHealth.ts's original comment, which predates job_runs existing.
 * Shared by the Heroku Scheduler script and System Health's on-demand "Run
 * Health Check Now" button, so both show up in the same job history instead
 * of the scheduled runs being invisible to that screen.
 */
export async function runIbkrHealthCheckJob(): Promise<void> {
  await runJob("ibkr_health_check", async () => {
    if (await isGatewayReachable()) {
      return { details: { output: "healthy" } };
    }

    const sshPrivateKey = Buffer.from(requireEnvironmentVariable("IBKR_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64"), "base64");

    const result = await runVpsHealthcheck({
      sshHost: environment.ibkrTunnelSshHost,
      sshPort: environment.ibkrTunnelSshPort,
      sshUsername: environment.ibkrTunnelSshUsername,
      sshPrivateKey,
    });

    if (await isGatewayReachable()) {
      return { details: { output: `unhealthy, restarted, recovered — restart script output: ${result.output.trim()}` } };
    }

    throw new Error(`IBKR Gateway unreachable and restart didn't recover it (script exit ${result.exitCode}): ${result.output.trim()}`);
  });
}
