import { runForcedCommandSsh } from "./runForcedCommandSsh.js";

export interface CheckWorkerOnVpsOptions {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPrivateKey: Buffer;
}

export interface CheckWorkerOnVpsResult {
  /** True if the worker was already active, or was inactive and the restart brought it back. */
  active: boolean;
  /** True if check-worker.sh had to run `systemctl restart` — worth surfacing even when the restart succeeded. */
  restarted: boolean;
  output: string;
}

// Checks iorio-worker.service's systemd status on the VPS and, unlike the
// Gateway (which the app can handshake with directly, so its check happens
// app-side — see restartIbkrGatewayOnVps.ts), does the check itself over
// SSH since there's no other channel to ask systemd for the worker's
// status. check-worker.sh restarts the unit in place if it finds it
// inactive and rechecks before returning, so a single SSH round-trip
// covers both the check and any needed recovery.
export async function checkWorkerOnVps(options: CheckWorkerOnVpsOptions): Promise<CheckWorkerOnVpsResult> {
  const { output } = await runForcedCommandSsh({
    ...options,
    // check-worker.sh only sleeps 5s on a restart (a plain Node process,
    // not the Gateway's full container login flow), generous margin above that.
    timeoutMs: 30_000,
    timeoutMessage: "Timed out running iorio-worker.service check on VPS.",
  });

  const restarted = output.includes("restarting iorio-worker.service");
  const finalStatusMatch = restarted
    ? output.match(/worker status after restart: (\S+)/)
    : output.match(/worker status: (\S+)/);
  const active = finalStatusMatch?.[1] === "active";

  return { active, restarted, output };
}
