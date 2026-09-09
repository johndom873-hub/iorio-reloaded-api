import { IBApi, EventName, type ErrorCode } from "@stoqey/ib";
import { environment } from "../config/env.js";
import { openIbkrTunnel, type IbkrTunnel } from "./ibkrGatewayTunnel.js";
import { ibkrGatewayPortByTradingMode } from "./constants.js";

// Step 1 of the "Shared IBKR Read Connection" design proposal (2026-09-09,
// see PROGRESS.md) — a single long-lived connection for the web dyno's
// read-only IBKR calls (account summary, quotes, greeks, historical bars,
// symbol search), reused across requests instead of connectIbkr.ts's
// one-shot connect/fetch/disconnect per call, which was costing ~4.5s of
// pure connect overhead on every dashboard/positions/risk-limits load.
//
// Deliberately NOT a refactor of ibkrGatewayPersistentConnection.ts (the
// worker's own persistent connection, order-execution-critical, gated by the
// project's require-explicit-approval-before-redeploying-ibkrGateway*-files
// convention) — this mirrors that module's reconnect-with-backoff shape
// independently so a read-latency change can never risk that file. Not
// prefixed ibkrGateway* itself: this code ships with the web dyno's normal
// Heroku auto-deploy, not the VPS worker's manual deploy path.
//
// Every caller must fall back to connectIbkr.ts's one-shot
// connectToIbkrGateway() if borrow() throws — this connection existing must
// never make a read *less* reliable than today, only faster when it's
// healthy. Only the first migrated caller (fetchAccountSummary.ts) is wired
// up so far; the rest stay on the one-shot path until that's proven out.

// Reserved, fixed — distinct from the worker's persistent connection
// (clientId 42) and from every one-shot read connection's random id
// (connectIbkr.ts). A long-lived connection benefits from a stable,
// identifiable id in IBKR's own TWS/Gateway UI, same reasoning as the
// worker's fixed id.
const webReadClientId = 43;

const reconnectDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

// How long a caller waits for a healthy shared connection before giving up
// and falling back to its own one-shot connect — kept short so a
// mid-reconnect shared connection never makes a request slower than today's
// ~4.5-5s one-shot baseline.
const borrowTimeoutMs = 3_000;

export interface BorrowedConnection {
  ib: IBApi;
  /** No-op on the shared connection — it stays open for the next borrower. Never call ib.disconnect() directly on a borrowed connection. */
  release: () => void;
}

class SharedReadConnection {
  private ib: IBApi | null = null;
  private tunnel: IbkrTunnel | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private connecting: Promise<void> | null = null;
  private connectedSince: number | null = null;
  private totalReconnects = 0;
  // Shared across every concurrent borrower — replaces each read helper's
  // old hardcoded reqId range (9001, 20000, 30000, ...), which only avoided
  // collisions because each one-shot call had a private socket to itself.
  private nextReqId = 1;

  allocateReqId(): number {
    return this.nextReqId++;
  }

  getHealthSnapshot(): { connected: boolean; uptimeMs: number | null; totalReconnects: number } {
    return {
      connected: this.ib !== null,
      uptimeMs: this.connectedSince ? Date.now() - this.connectedSince : null,
      totalReconnects: this.totalReconnects,
    };
  }

  /**
   * Resolves with the shared connection if already up, or waits up to
   * borrowTimeoutMs for an in-flight (re)connect. Throws if neither happens
   * in time — the caller must fall back to connectToIbkrGateway() rather
   * than block indefinitely on this connection.
   */
  async borrow(): Promise<BorrowedConnection> {
    if (this.ib) {
      const ib = this.ib;
      return { ib, release: () => {} };
    }

    if (!this.connecting) this.connecting = this.connect();

    await Promise.race([
      this.connecting,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("Shared IBKR read connection not ready within timeout.")), borrowTimeoutMs);
      }),
    ]);

    if (!this.ib) throw new Error("Shared IBKR read connection not ready.");
    const ib = this.ib;
    return { ib, release: () => {} };
  }

  private async connect(): Promise<void> {
    const connectStartedAt = Date.now();
    console.log(
      `IBKR shared read connection: opening SSH tunnel to ${environment.ibkrTunnelSshHost}:${environment.ibkrTunnelSshPort} → ${environment.ibkrGatewayHost}:${ibkrGatewayPortByTradingMode[environment.ibkrTradingMode]}...`,
    );
    const sshPrivateKey = Buffer.from(environment.ibkrTunnelSshPrivateKeyBase64, "base64");

    try {
      const tunnel = await openIbkrTunnel({
        sshHost: environment.ibkrTunnelSshHost,
        sshPort: environment.ibkrTunnelSshPort,
        sshUsername: environment.ibkrTunnelSshUsername,
        sshPrivateKey,
        remoteHost: environment.ibkrGatewayHost,
        remotePort: ibkrGatewayPortByTradingMode[environment.ibkrTradingMode],
      });
      console.log(
        `IBKR shared read connection: SSH tunnel open on local port ${tunnel.localPort} (${Date.now() - connectStartedAt}ms) — connecting to IBKR API with clientId ${webReadClientId}...`,
      );

      const ib = new IBApi({ host: "127.0.0.1", port: tunnel.localPort });

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error, code: ErrorCode, reqId: number) => {
          if (reqId === -1) {
            console.log(`IBKR shared read connection: informational status during connect: ${code} ${error.message}`);
            return;
          }
          console.error(`IBKR shared read connection: connect failed with error ${code}: ${error.message} (after ${Date.now() - connectStartedAt}ms)`);
          cleanup();
          tunnel.close();
          reject(error);
        };
        const onConnected = () => {
          cleanup();
          resolve();
        };
        const timer = setTimeout(() => {
          console.error(`IBKR shared read connection: connect timed out after ${Date.now() - connectStartedAt}ms waiting for nextValidId.`);
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
        ib.connect(webReadClientId);
      });

      this.ib = ib;
      this.tunnel = tunnel;
      this.reconnectAttempt = 0;
      this.connectedSince = Date.now();
      console.log(
        `IBKR shared read connection: connected (took ${Date.now() - connectStartedAt}ms total, lifetime reconnects=${this.totalReconnects}).`,
      );

      // Same reasoning as ibkrGatewayPersistentConnection.ts's post-connect
      // listener: reqId -1 carries broadcast connection-status notices
      // (market data farm up/down, etc.) that no per-request listener
      // catches, and this connection lives long enough for that to matter.
      ib.on(EventName.error, (error, code, reqId) => {
        if (reqId !== -1) return;
        console.log(`IBKR shared read connection: system status ${code}: ${error.message}`);
      });

      ib.once(EventName.disconnected, () => this.handleDisconnect());
    } finally {
      this.connecting = null;
    }
  }

  private handleDisconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const uptimeMs = this.connectedSince ? Date.now() - this.connectedSince : null;
    this.connectedSince = null;
    this.ib = null;
    this.tunnel?.close();
    this.tunnel = null;
    this.totalReconnects++;

    const delay = reconnectDelaysMs[Math.min(this.reconnectAttempt, reconnectDelaysMs.length - 1)];
    this.reconnectAttempt++;
    console.error(
      `IBKR shared read connection dropped after ${uptimeMs !== null ? `${Math.round(uptimeMs / 1000)}s uptime` : "unknown uptime"} — reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}, lifetime reconnects=${this.totalReconnects}). Reads will fall back to one-shot connections until this recovers.`,
    );

    setTimeout(() => {
      this.reconnecting = false;
      this.connect().catch((error) => {
        console.error(`IBKR shared read connection reconnect failed: ${error instanceof Error ? error.message : error}`);
        this.handleDisconnect();
      });
    }, delay);
  }
}

export const sharedReadConnection = new SharedReadConnection();
