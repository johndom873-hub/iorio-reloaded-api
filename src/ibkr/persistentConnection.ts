import { IBApi, EventName, type ErrorCode } from "@stoqey/ib";
import { environment } from "../config/env.js";
import { openIbkrTunnel, type IbkrTunnel } from "./tunnel.js";
import { ibkrGatewayPortByTradingMode } from "./constants.js";

// Every other IBKR call site (connectIbkr.ts) opens a connection per request
// and closes it when done — fine for one-shot reads, but real-time order
// status/execution/position monitoring needs a subscription that stays open.
// This module holds exactly one such connection for the worker process's
// lifetime, reconnecting with backoff if it drops. Not usable from the web
// dyno — that process still uses connectToIbkrGateway's per-request pattern
// for its own reads (quotes, chains, etc.), which don't need a standing
// subscription. See PROGRESS.md's "IBKR is the source of truth" decision,
// 2026-08-24.

// Reserved, fixed — every other connection in the app uses a random clientId
// (see connectIbkr.ts's comment) because many short-lived connections need
// to avoid colliding with each other. This is the one long-lived connection,
// so a fixed id is safer: collisions are impossible to reason about with a
// process that's supposed to stay connected indefinitely, and a fixed id
// makes it unambiguous in IBKR's own TWS/Gateway UI which client is the
// worker.
const workerClientId = 42;

const reconnectDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

export type IbkrConnectionListener = (ib: IBApi) => void;

class PersistentIbkrConnection {
  private ib: IBApi | null = null;
  private tunnel: IbkrTunnel | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private onConnectListeners: IbkrConnectionListener[] = [];
  private nextOrderId: number | null = null;

  /** Fires every time a connection is (re)established, including the first. */
  onConnect(listener: IbkrConnectionListener): void {
    this.onConnectListeners.push(listener);
    if (this.ib) listener(this.ib);
  }

  /** The current connection, or null if not currently connected (e.g. mid-reconnect). */
  getIb(): IBApi | null {
    return this.ib;
  }

  /**
   * Order ids must be unique and sequential per IBKR's rules — this hands
   * out one starting from the id IBKR gave us at connect time (nextValidId)
   * and increments locally, avoiding a round-trip reqIds() call before every
   * single order. Reset on reconnect via a fresh nextValidId.
   */
  getNextOrderId(): number {
    if (this.nextOrderId === null) {
      throw new Error("No IBKR order id available yet — not connected.");
    }
    return this.nextOrderId++;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const sshPrivateKey = Buffer.from(environment.ibkrTunnelSshPrivateKeyBase64, "base64");

    const tunnel = await openIbkrTunnel({
      sshHost: environment.ibkrTunnelSshHost,
      sshPort: environment.ibkrTunnelSshPort,
      sshUsername: environment.ibkrTunnelSshUsername,
      sshPrivateKey,
      remoteHost: environment.ibkrGatewayHost,
      remotePort: ibkrGatewayPortByTradingMode[environment.ibkrTradingMode],
    });

    const ib = new IBApi({ host: "127.0.0.1", port: tunnel.localPort });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error, _code: ErrorCode, reqId: number) => {
        if (reqId === -1) return; // informational connection-status notices, not real errors
        cleanup();
        tunnel.close();
        reject(error);
      };
      const onConnected = (orderId: number) => {
        this.nextOrderId = orderId;
        cleanup();
        resolve();
      };
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
      ib.connect(workerClientId);
    });

    this.ib = ib;
    this.tunnel = tunnel;
    this.reconnectAttempt = 0;

    ib.once(EventName.disconnected, () => this.handleDisconnect());

    for (const listener of this.onConnectListeners) listener(ib);
  }

  private handleDisconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.ib = null;
    this.tunnel?.close();
    this.tunnel = null;

    const delay = reconnectDelaysMs[Math.min(this.reconnectAttempt, reconnectDelaysMs.length - 1)];
    this.reconnectAttempt++;
    console.error(`IBKR worker connection dropped — reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}).`);

    setTimeout(() => {
      this.reconnecting = false;
      this.connect().catch((error) => {
        console.error(`IBKR worker reconnect failed: ${error instanceof Error ? error.message : error}`);
        this.handleDisconnect();
      });
    }, delay);
  }
}

export const persistentIbkrConnection = new PersistentIbkrConnection();
