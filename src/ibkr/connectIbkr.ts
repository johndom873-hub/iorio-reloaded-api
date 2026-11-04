import { IBApi, EventName, type ErrorCode } from "@stoqey/ib";
import { environment } from "../config/env.js";
import { openIbkrTunnel } from "./ibkrGatewayTunnel.js";
import { ibkrGatewayPortByTradingMode, ibkrMessagesPerSecondBudget } from "./constants.js";
import { runIbkrHandshake } from "./ibkrHandshakeQueue.js";

export interface IbkrConnection {
  ib: IBApi;
  disconnect: () => void;
}

/** An account-wide IBKR notice (no request id): farm status such as 2105 "HMDS data farm connection is broken", connectivity, version. */
export interface IbkrConnectionNotice {
  at: string;
  code: number;
  message: string;
}

// The notices that say a link is down or back (connectivity 1100/1101/1102, market data farm 2103, historical data farm
// 2105, IBKR server 2110, contract definitions 2157): logged on every connection, since they explain later timeouts. The
// routine "OK" and "inactive but available" notices are not logged.
const loggedConnectionNoticeCodes: ReadonlySet<number> = new Set([1100, 1101, 1102, 2103, 2105, 2110, 2157]);

/**
 * Opens the SSH tunnel to the IBKR VPS, then connects @stoqey/ib to Gateway
 * through it. Resolves once IBKR has actually accepted the connection
 * (signaled by nextValidId), not just once the socket is open.
 *
 * @stoqey/ib delivers IBKR's account-wide notices (request id -1) as EventName.info, never as EventName.error, and the
 * farm-status ones arrive in the same packet as nextValidId: a listener attached after this resolves misses them. So
 * `onNotice` is attached before connecting and receives every notice for the connection's lifetime.
 */
export async function connectToIbkrGateway(options: { onNotice?: (notice: IbkrConnectionNotice) => void } = {}): Promise<IbkrConnection> {
  const sshPrivateKey = Buffer.from(environment.ibkrTunnelSshPrivateKeyBase64, "base64");

  const tunnel = await openIbkrTunnel({
    sshHost: environment.ibkrTunnelSshHost,
    sshPort: environment.ibkrTunnelSshPort,
    sshUsername: environment.ibkrTunnelSshUsername,
    sshPrivateKey,
    remoteHost: environment.ibkrGatewayHost,
    remotePort: ibkrGatewayPortByTradingMode[environment.ibkrTradingMode],
  });

  const ib = new IBApi({
    host: "127.0.0.1",
    port: tunnel.localPort,
    maxReqPerSec: ibkrMessagesPerSecondBudget.oneShot,
  });

  return runIbkrHandshake(
    () =>
      new Promise((resolve, reject) => {
        // Concurrent requests each open their own connection (see
        // fetchNewTickerData.ts, streamTickerDetail.ts, etc.) — every connect
        // needs its own clientId, or IBKR silently ignores the second connection
        // attempt using an already-connected id (default is 0) and this promise
        // would hang forever with neither nextValidId nor an error ever firing.
        const clientId = Math.floor(Math.random() * 1_000_000);

        const onError = (error: Error, _code: ErrorCode, reqId: number) => {
          // A reqId -1 error is an account-wide notice, not a failure of this connect (@stoqey/ib sends most of those as
          // EventName.info instead). Anything else during the initial handshake is real.
          if (reqId === -1) return;
          cleanup();
          tunnel.close();
          reject(error);
        };

        const onConnected = () => {
          cleanup();
          // Logged for the lifetime of the connection: every other error handler filters to its own request id and drops
          // anything else. Account-wide notices (farm status) come as EventName.info, handled below.
          ib.on(EventName.error, (error, code, reqId) => {
            console.log(`IBKR connection event (reqId=${reqId}, code=${code}): ${error.message}`);
          });
          resolve({
            ib,
            disconnect: () => {
              ib.disconnect();
              tunnel.close();
            },
          });
        };

        // Safety net: IBKR should always either signal nextValidId or fire an
        // error, but a hung Gateway/tunnel with neither happening would
        // otherwise leave this promise — and every caller awaiting it — stuck
        // forever with no way to recover short of restarting the process.
        const timer = setTimeout(() => {
          cleanup();
          tunnel.close();
          reject(new Error("Timed out connecting to IBKR Gateway."));
        }, 15_000);

        function cleanup() {
          clearTimeout(timer);
          ib.off(EventName.error, onError);
          ib.off(EventName.nextValidId, onConnected);
        }

        ib.on(EventName.info, (message: string, code: number) => {
          if (loggedConnectionNoticeCodes.has(code)) console.log(`IBKR connection notice (code=${code}): ${message}`);
          options.onNotice?.({ at: new Date().toISOString(), code, message });
        });
        ib.on(EventName.error, onError);
        ib.once(EventName.nextValidId, onConnected);

        ib.connect(clientId);
      }),
  );
}
