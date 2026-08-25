import { Client as SshClient } from "ssh2";

export interface ForcedCommandSshResult {
  exitCode: number | null;
  output: string;
}

export interface RunForcedCommandSshOptions {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPrivateKey: Buffer;
  /** Milliseconds before giving up on a hung SSH channel — see the timeout comment below. */
  timeoutMs: number;
  timeoutMessage: string;
}

/**
 * Runs a script on the VPS over SSH where the key is locked to a forced
 * command in the VPS's authorized_keys (`command="...",restrict`), so the
 * command string passed to `exec()` is irrelevant — the server always runs
 * whatever script that specific key is bound to, regardless of what's
 * requested. Shared by restartIbkrGatewayOnVps.ts and checkWorkerOnVps.ts,
 * which differ only in which key/script they use and how long they're
 * willing to wait. See project_ibkr_healthcheck_ssh_key memory for the key
 * setup.
 */
export function runForcedCommandSsh(options: RunForcedCommandSshOptions): Promise<ForcedCommandSshResult> {
  return new Promise((resolve, reject) => {
    const sshClient = new SshClient();
    let output = "";
    let settled = false;

    // Safety net against a hung SSH channel (remote command's stdout never
    // closing, a dropped connection with no error event) — otherwise this
    // promise, and the caller process, would be stuck forever. Found
    // 2026-08-21: an earlier run with no timeout left a Node process
    // running 18+ hours after the SSH session it was waiting on had gone
    // stale.
    const timer = setTimeout(() => {
      settle(() => reject(new Error(options.timeoutMessage)));
    }, options.timeoutMs);

    function settle(action: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sshClient.end();
      action();
    }

    sshClient.on("ready", () => {
      sshClient.exec("forced-command", (error, stream) => {
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
