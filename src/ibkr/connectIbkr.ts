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

    function cleanup() {
      ib.off(EventName.error, onError);
      ib.off(EventName.nextValidId, onConnected);
    }

    ib.on(EventName.error, onError);
    ib.once(EventName.nextValidId, onConnected);

    ib.connect();
  });
}
