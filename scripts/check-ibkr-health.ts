// Hourly job (Heroku Scheduler): checks whether the IBKR paper Gateway is
// reachable, and asks the VPS to attempt one restart if it isn't. Runs the
// VPS-side /opt/ibkr/healthcheck.sh over SSH via a narrowly-restricted key
// that can only ever trigger that one script (see PROGRESS.md's "Hourly
// IBKR Gateway health-check" entry for the design rationale).
//
// Alerts on *every* failure via Telegram, not just state transitions —
// see notifyTelegram.ts for why (no job_runs table yet to compare against).
// If TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID aren't set, notifyTelegram no-ops
// with a console warning rather than failing this job.
//
// Usage (dev):
//   npm run check-ibkr-health
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/check-ibkr-health.js

import { runVpsHealthcheck } from "../src/ibkr/runVpsHealthcheck.js";
import { notifyTelegram } from "../src/lib/notifyTelegram.js";
import { environment } from "../src/config/env.js";

function requireEnvironmentVariable(variableName: string): string {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return value;
}

async function main(): Promise<void> {
  // Deliberately read directly from process.env rather than added to
  // src/config/env.ts's `environment` object — that object is required at
  // import time by the main API server too, and this key is only ever
  // needed by this standalone script, not by the app itself.
  const sshPrivateKey = Buffer.from(requireEnvironmentVariable("IBKR_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64"), "base64");

  const result = await runVpsHealthcheck({
    sshHost: environment.ibkrTunnelSshHost,
    sshPort: environment.ibkrTunnelSshPort,
    sshUsername: environment.ibkrTunnelSshUsername,
    sshPrivateKey,
  });

  console.log(result.output.trim());

  if (result.exitCode !== 0) {
    console.error(`IBKR Gateway health check failed (exit ${result.exitCode}) — needs manual attention.`);
    process.exitCode = 1;
    await notifyTelegram(`⚠️ IBKR Gateway health check failed (exit ${result.exitCode}):\n\n${result.output.trim()}`);
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
  await notifyTelegram(`⚠️ IBKR Gateway health check crashed: ${message}`);
});
