import { IBApi, EventName, type ErrorCode } from "@stoqey/ib";
import { environment } from "../config/env.js";
import { openIbkrTunnel } from "./tunnel.js";
import { ibkrGatewayPortByTradingMode } from "./constants.js";

export interface IbkrConnection {
  ib: IBApi;
  disconnect: () => void;
}

/**
 * Opens the SSH tunnel to the IBKR VPS, then connects @stoqey/ib to Gateway
 * through it. Resolves once IBKR has actually accepted the connection
 * (signaled by nextValidId), not just once the socket is open.
 */
export async function connectToIbkrGateway(): Promise<IbkrConnection> {
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
  });

  return new Promise((resolve, reject) => {
    // Concurrent requests each open their own connection (see
    // fetchNewTickerData.ts, fetchTickerDetail.ts, etc.) — every connect
    // needs its own clientId, or IBKR silently ignores the second connection
    // attempt using an already-connected id (default is 0) and this promise
    // would hang forever with neither nextValidId nor an error ever firing.
    const clientId = Math.floor(Math.random() * 1_000_000);

    const onError = (error: Error, _code: ErrorCode, reqId: number) => {
      // reqId -1 carries connection-status notices (e.g. "market data farm
      // connection is OK"), not real errors — IBKR's API overloads the error
      // event for these. Anything else during the initial handshake is real.
      if (reqId === -1) return;
      cleanup();
      tunnel.close();
      reject(error);
    };

    const onConnected = () => {
      cleanup();
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

    ib.on(EventName.error, onError);
    ib.once(EventName.nextValidId, onConnected);

    ib.connect(clientId);
  });
}
