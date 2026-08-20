import { runVpsHealthcheck } from "./runVpsHealthcheck.js";
import { runJob } from "../lib/runJob.js";
import { environment } from "../config/env.js";

function requireEnvironmentVariable(variableName: string): string {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return value;
}

/**
 * Runs the IBKR Gateway health-check/recovery script on the VPS and logs
 * the result via runJob (job_runs), same as the other 3 scheduled jobs —
 * see checkIbkrHealth.ts's original comment, which predates job_runs
 * existing. Shared by the Heroku Scheduler script and System Health's
 * on-demand "Run Health Check Now" button, so both show up in the same job
 * history instead of the scheduled runs being invisible to that screen.
 */
export async function runIbkrHealthCheckJob(): Promise<void> {
  await runJob("ibkr_health_check", async () => {
    const sshPrivateKey = Buffer.from(requireEnvironmentVariable("IBKR_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64"), "base64");

    const result = await runVpsHealthcheck({
      sshHost: environment.ibkrTunnelSshHost,
      sshPort: environment.ibkrTunnelSshPort,
      sshUsername: environment.ibkrTunnelSshUsername,
      sshPrivateKey,
    });

    if (result.exitCode !== 0) {
      throw new Error(`IBKR Gateway health check failed (exit ${result.exitCode}): ${result.output.trim()}`);
    }

    return { details: { output: result.output.trim() } };
  });
}
