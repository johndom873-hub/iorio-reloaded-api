import { IBApi, EventName, type ErrorCode } from "@stoqey/ib";
import { environment } from "../config/env.js";
import { openIbkrTunnel, type IbkrTunnel } from "./ibkrGatewayTunnel.js";
import { ibkrGatewayPortByTradingMode, ibkrMessagesPerSecondBudget } from "./constants.js";

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
  private connectedSince: number | null = null;
  private totalReconnects = 0;
  private lastSystemStatusCode: number | null = null;
  private lastSystemStatusAt: number | null = null;
  // Sent by Gateway during the handshake; kept across reconnects so the last
  // known accounts stay visible while briefly disconnected.
  private managedAccountIds: string[] = [];
  // Starts "disconnected since process start"; null while connected.
  private disconnectedSince: number | null = Date.now();

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

  /**
   * Never rejects on a connect failure: if the Gateway is unreachable (e.g.
   * IBKR maintenance) the worker stays up and retries with the same backoff
   * as a mid-session drop, instead of exiting and letting systemd restart-loop
   * it (one Telegram alert per restart). Alerting on a prolonged outage is the
   * caller's job, driven by getHealthSnapshot().disconnectedSinceMs.
   */
  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      console.error(`IBKR worker: initial connect failed: ${error instanceof Error ? error.message : error} — staying up and retrying with backoff.`);
      this.scheduleReconnect();
    }
  }

  private async connect(): Promise<void> {
    const connectStartedAt = Date.now();
    console.log(`IBKR worker: opening SSH tunnel to ${environment.ibkrTunnelSshHost}:${environment.ibkrTunnelSshPort} → ${environment.ibkrGatewayHost}:${ibkrGatewayPortByTradingMode[environment.ibkrTradingMode]}...`);
    const sshPrivateKey = Buffer.from(environment.ibkrTunnelSshPrivateKeyBase64, "base64");

    const tunnel = await openIbkrTunnel({
      sshHost: environment.ibkrTunnelSshHost,
      sshPort: environment.ibkrTunnelSshPort,
      sshUsername: environment.ibkrTunnelSshUsername,
      sshPrivateKey,
      remoteHost: environment.ibkrGatewayHost,
      remotePort: ibkrGatewayPortByTradingMode[environment.ibkrTradingMode],
    });
    console.log(`IBKR worker: SSH tunnel open on local port ${tunnel.localPort} (${Date.now() - connectStartedAt}ms) — connecting to IBKR API with clientId ${workerClientId}...`);

    // Forget the previous session's accounts: a reconnect may land on a different Gateway login, and an old
    // list must never make a new session look bound (see ibkrGatewayAccountBinding.ts).
    this.managedAccountIds = [];
    const ib = new IBApi({ host: "127.0.0.1", port: tunnel.localPort, maxReqPerSec: ibkrMessagesPerSecondBudget.worker });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error, code: ErrorCode, reqId: number) => {
        if (reqId === -1) {
          // Informational connection-status notice during handshake, not a
          // real error — but log it anyway (previously discarded silently),
          // since these can carry the actual reason a subsequent connect
          // attempt is slow/fails (e.g. Gateway still logging in, market
          // data farm not yet up).
          console.log(`IBKR worker: informational status during connect: ${code} ${error.message}`);
          return;
        }
        console.error(`IBKR worker: connect failed with error ${code}: ${error.message} (after ${Date.now() - connectStartedAt}ms)`);
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
        console.error(`IBKR worker: connect timed out after ${Date.now() - connectStartedAt}ms waiting for nextValidId.`);
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
      ib.on(EventName.managedAccounts, (accountsList: string) => {
        this.managedAccountIds = accountsList.split(",").map((accountId) => accountId.trim()).filter(Boolean);
      });
      ib.connect(workerClientId);
    });

    this.ib = ib;
    this.tunnel = tunnel;
    this.reconnectAttempt = 0;
    this.connectedSince = Date.now();
    this.disconnectedSince = null;
    console.log(
      `IBKR worker: connected (nextOrderId=${this.nextOrderId}, took ${Date.now() - connectStartedAt}ms total, lifetime reconnects=${this.totalReconnects}).`,
    );

    // Every non-order-scoped error/status IBKR pushes after connect — market
    // data farm connectivity (2103/2105/2106/2108/2119...), "connectivity
    // lost/restored" (1100-1102), etc. Previously invisible entirely once
    // the handshake's own onError listener was torn down in cleanup() above
    // — added specifically because the worker has needed several
    // unexplained restarts/day and there was no IBKR-side signal on record
    // to correlate against.
    ib.on(EventName.error, (error, code, reqId) => {
      if (reqId !== -1) return; // order-scoped errors are handled by ibkrGatewayWorker.ts's own listener
      this.lastSystemStatusCode = code;
      this.lastSystemStatusAt = Date.now();
      console.log(`IBKR worker: system status ${code}: ${error.message}`);
    });

    ib.once(EventName.disconnected, () => this.handleDisconnect());

    for (const listener of this.onConnectListeners) listener(ib);
  }

  private handleDisconnect(): void {
    if (this.reconnecting) return;
    const uptimeMs = this.connectedSince ? Date.now() - this.connectedSince : null;
    this.connectedSince = null;
    this.disconnectedSince ??= Date.now();
    this.ib = null;
    this.tunnel?.close();
    this.tunnel = null;
    this.totalReconnects++;

    const lastStatus =
      this.lastSystemStatusCode !== null
        ? ` Last IBKR system status before drop: ${this.lastSystemStatusCode} (${Math.round((Date.now() - (this.lastSystemStatusAt ?? Date.now())) / 1000)}s ago).`
        : " No IBKR system status was logged before this drop.";
    console.error(
      `IBKR worker connection dropped after ${uptimeMs !== null ? `${Math.round(uptimeMs / 1000)}s uptime` : "unknown uptime"} (lifetime reconnects=${this.totalReconnects}).${lastStatus}`,
    );
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const delay = reconnectDelaysMs[Math.min(this.reconnectAttempt, reconnectDelaysMs.length - 1)];
    this.reconnectAttempt++;
    console.error(`IBKR worker: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}).`);

    setTimeout(() => {
      this.reconnecting = false;
      this.connect().catch((error) => {
        console.error(`IBKR worker reconnect failed: ${error instanceof Error ? error.message : error}`);
        this.handleDisconnect();
      });
    }, delay);
  }

  /**
   * For the periodic heartbeat log in ibkrGatewayWorker.ts's main(), and
   * (since 2026-09-13) upserted into worker_health there too for Iorio
   * Pulse's Gateway node — see that file's comment on the upsert interval.
   */
  getHealthSnapshot(): { connected: boolean; uptimeMs: number | null; disconnectedSinceMs: number | null; totalReconnects: number; lastSystemStatusCode: number | null; clientId: number; managedAccountIds: string[] } {
    return {
      connected: this.ib !== null,
      uptimeMs: this.connectedSince ? Date.now() - this.connectedSince : null,
      disconnectedSinceMs: this.disconnectedSince,
      totalReconnects: this.totalReconnects,
      lastSystemStatusCode: this.lastSystemStatusCode,
      clientId: workerClientId,
      managedAccountIds: this.managedAccountIds,
    };
  }
}

export const persistentIbkrConnection = new PersistentIbkrConnection();
