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

    // Real incident (2026-08-27): an sshClient.connect() call that neither
    // fires 'ready' nor 'error' left this promise pending forever with no
    // way to recover. Every caller (connectIbkr.ts's one-shot connections,
    // and persistentConnection.ts's reconnect loop) awaits this before its
    // own timeout logic even starts, so a hang here is invisible to those —
    // the persistent worker's reconnect loop in particular has nothing else
    // guarding this step and would freeze silently until the process was
    // restarted by hand.
    const timer = setTimeout(() => {
      sshClient.end();
      reject(new Error("Timed out opening SSH tunnel to IBKR Gateway."));
    }, 15_000);

    sshClient.on("ready", () => {
      clearTimeout(timer);
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
            // Root cause of a real crash (2026-08-27): neither side of this
            // pipe had an 'error' listener. A Node stream that emits 'error'
            // with no listener throws, which crashes the whole process
            // (uncaughtException, "read ECONNRESET") rather than just
            // failing this one IBKR connection. Long-lived streaming
            // connections (prices/option chain now stay subscribed for as
            // long as a modal is open, not ~20s one-shot calls) sit exposed
            // to a transient network blip for much longer, so this got much
            // more likely to actually hit. Destroying the other side on
            // either socket's error is standard proxy-pipe cleanup — it
            // surfaces as this one IBKR connection dying (which
            // connectIbkr.ts's callers already handle as a normal
            // section-level error), not a process-wide crash.
            stream.on("error", () => localSocket.destroy());
            localSocket.on("error", () => stream.destroy());
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
      clearTimeout(timer);
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
