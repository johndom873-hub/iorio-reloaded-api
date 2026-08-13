import { Client as SshClient } from "ssh2";
import net from "node:net";

export interface IbkrTunnel {
  /** Local port that proxies to the Gateway on the far end of the SSH tunnel. */
  localPort: number;
  close: () => void;
}

export interface OpenIbkrTunnelOptions {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPrivateKey: Buffer;
  remoteHost: string;
  remotePort: number;
}

/**
 * Opens an SSH tunnel to the IBKR VPS and forwards a local ephemeral port to
 * the Gateway's port on the far side (which is only bound to the VPS's own
 * localhost, never exposed to the internet). Mirrors `ssh -L`.
 */
export function openIbkrTunnel(options: OpenIbkrTunnelOptions): Promise<IbkrTunnel> {
  return new Promise((resolve, reject) => {
    const sshClient = new SshClient();

    sshClient.on("ready", () => {
      const localServer = net.createServer((localSocket) => {
        sshClient.forwardOut(
          localSocket.remoteAddress ?? "127.0.0.1",
          localSocket.remotePort ?? 0,
          options.remoteHost,
          options.remotePort,
          (error, stream) => {
            if (error) {
              localSocket.destroy();
              return;
            }
            localSocket.pipe(stream).pipe(localSocket);
          },
        );
      });

      localServer.on("error", (error) => {
        reject(error);
      });

      localServer.listen(0, "127.0.0.1", () => {
        const address = localServer.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Failed to determine local IBKR tunnel port"));
          return;
        }
        resolve({
          localPort: address.port,
          close: () => {
            localServer.close();
            sshClient.end();
          },
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
