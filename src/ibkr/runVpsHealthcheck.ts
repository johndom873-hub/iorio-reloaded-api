import { Client as SshClient } from "ssh2";

export interface VpsHealthcheckResult {
  exitCode: number | null;
  output: string;
}

export interface RunVpsHealthcheckOptions {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPrivateKey: Buffer;
}

// Runs the IBKR Gateway health-check/recovery script on the VPS over SSH.
// The command string passed to exec() here is irrelevant — the healthcheck
// SSH key is locked to a forced command in the VPS's authorized_keys
// (command="/opt/ibkr/healthcheck.sh",restrict), so the server always runs
// that script regardless of what's requested. See
// project_ibkr_healthcheck_ssh_key memory for the key setup.
export function runVpsHealthcheck(options: RunVpsHealthcheckOptions): Promise<VpsHealthcheckResult> {
  return new Promise((resolve, reject) => {
    const sshClient = new SshClient();
    let output = "";
    let settled = false;

    // Safety net: the restart script normally finishes in well under a
    // minute (25s sleep plus restart time), but a hung SSH channel — the
    // remote command's stdout never closing, a dropped connection with no
    // error event — would otherwise leave this promise, and the caller
    // process, stuck forever. Found 2026-08-21: an earlier run with no
    // timeout left a Node process running 18+ hours after the SSH session
    // it was waiting on had gone stale.
    const timer = setTimeout(() => {
      settle(() => reject(new Error("Timed out running IBKR Gateway restart script on VPS.")));
    }, 90_000);

    function settle(action: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sshClient.end();
      action();
    }

    sshClient.on("ready", () => {
      sshClient.exec("healthcheck", (error, stream) => {
        if (error) {
          settle(() => reject(error));
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        stream.on("close", (exitCode: number | null) => {
          settle(() => resolve({ exitCode, output }));
        });
      });
    });

    sshClient.on("error", (error) => {
      settle(() => reject(error));
    });

    sshClient.connect({
      host: options.sshHost,
      port: options.sshPort,
      username: options.sshUsername,
      privateKey: options.sshPrivateKey,
      readyTimeout: 15_000,
    });
  });
}
