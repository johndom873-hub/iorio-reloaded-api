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

    sshClient.on("ready", () => {
      sshClient.exec("healthcheck", (error, stream) => {
        if (error) {
          sshClient.end();
          reject(error);
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        stream.on("close", (exitCode: number | null) => {
          sshClient.end();
          resolve({ exitCode, output });
        });
      });
    });

    sshClient.on("error", (error) => {
      reject(error);
    });

    sshClient.connect({
      host: options.sshHost,
      port: options.sshPort,
      username: options.sshUsername,
      privateKey: options.sshPrivateKey,
    });
  });
}
