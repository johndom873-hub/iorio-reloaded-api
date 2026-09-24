import { IBApi, EventName, MarketDataType, type ErrorCode } from "@stoqey/ib";
import { environment } from "../config/env.js";
import { openIbkrTunnel, type IbkrTunnel } from "./ibkrGatewayTunnel.js";
import { ibkrGatewayPortByTradingMode, ibkrMessagesPerSecondBudget } from "./constants.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { runIbkrHandshake } from "./ibkrHandshakeQueue.js";
import { markMarketDataTypeManaged } from "./requestMarketData.js";

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
// healthy. Callers migrated so far: account summary, live prices and
// greeks (one-shot and streaming), price bars and ticker search on the read
// connection; the Ticker Detail stream on the live connection below. The rest
// stay on the one-shot path until they are moved and tested one at a time.

// Random per connect attempt, not fixed (changed 2026-09-19 from a fixed 44).
// IBKR only needs every simultaneous connection to a Gateway to have its own
// id, and silently ignores a second connection that reuses one — with a fixed
// id, two processes booting together (duplicate dev servers, a Heroku deploy
// overlap) hung each other's handshake until the timeout, and a fixed id can
// also get permanently wedged inside Gateway itself (found 2026-09-11 for
// id 43, surviving a full Gateway restart). A fresh draw per attempt avoids
// both. Each connection draws from its own range, all of them above the
// one-shot connections' 0-999,999 (connectIbkr.ts) and the worker's fixed
// 42, so none of them can ever collide with those.
function pickClientId(rangeStart: number, rangeSize: number): number {
  return rangeStart + Math.floor(Math.random() * rangeSize);
}

const reconnectDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

// How long a caller waits for a healthy shared connection before giving up
// and falling back to its own one-shot connect — kept short so a
// mid-reconnect shared connection never makes a request slower than today's
// ~4.5-5s one-shot baseline. Overridable per instance (see
// setBorrowTimeoutMs) for one-off batch scripts, which have no user waiting
// on latency and would rather queue behind the reconnect than pile a burst
// of competing one-shot connections onto IBKR's single-live-session-per-login
// limit — found 2026-09-23 backfilling the option chain capture job: a
// mid-run shared-connection drop made every in-flight fetchLivePrices/
// fetchLiveGreeks call fall back independently within the same few seconds,
// and those one-shot connections competed with each other and with the
// always-on VPS worker for the account's one live-data slot, extending the
// outage well past the reconnect backoff itself.
const defaultBorrowTimeoutMs = 3_000;

export interface BorrowedConnection {
  ib: IBApi;
  /** No-op on the shared connection — it stays open for the next borrower. Never call ib.disconnect() directly on a borrowed connection. */
  release: () => void;
}

// Every shared connection's ib -> its own reqId allocator, so any helper that
// is handed just an `ib` (lookupOptionParams, lookupExpiryStrikes,
// fetchQuotesForContracts, derived IV-bar ids, ...) takes its ids from the
// right counter without every signature having to thread an allocator
// through. reqIds only need to be unique per connection, and on a shared one
// the old per-caller fixed/private counters (1-4, 5,000+, 10,000+, reqId+1000)
// would collide across concurrent requests — or with this counter itself.
const reqIdAllocatorByIb = new WeakMap<IBApi, () => number>();

/**
 * A fresh reqId for `ib`: from the shared connection's own counter when `ib`
 * is one of them, otherwise from `fallback` (a one-shot connection's private
 * socket, where the callers' own numbering is safe).
 */
export function nextReqIdFor(ib: IBApi, fallback: () => number): number {
  const allocateFromSharedConnection = reqIdAllocatorByIb.get(ib);
  return allocateFromSharedConnection ? allocateFromSharedConnection() : fallback();
}

interface SharedConnectionOptions {
  /** Used in log lines and error messages, e.g. "read" or "live". */
  label: string;
  /** Per-instance outbound message cap — see ibkrMessagesPerSecondBudget in constants.ts. */
  maxRequestsPerSecond: number;
  clientIdRangeStart: number;
  clientIdRangeSize: number;
  /**
   * When set, sent once each time this connection (re)connects, and every
   * requestRealtimeMarketData call on it becomes a no-op — for a connection
   * whose concurrent borrowers must never change the connection-wide market
   * data type under each other. Omitted on the read connection, whose
   * borrowers each set their own type right before requesting.
   */
  fixedMarketDataType?: MarketDataType;
}

class SharedReadConnection {
  constructor(private readonly options: SharedConnectionOptions) {}

  private ib: IBApi | null = null;
  private tunnel: IbkrTunnel | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private connecting: Promise<void> | null = null;
  private connectedSince: number | null = null;
  private totalReconnects = 0;
  private shuttingDown = false;
  // Shared across every concurrent borrower — replaces each read helper's
  // old hardcoded reqId range (9001, 20000, 30000, ...), which only avoided
  // collisions because each one-shot call had a private socket to itself.
  private nextReqId = 1;
  private borrowTimeoutMs = defaultBorrowTimeoutMs;

  allocateReqId(): number {
    return this.nextReqId++;
  }

  /**
   * For one-off batch scripts only (see the borrowTimeoutMs comment above) —
   * never call this from web-dyno request-handling code, where the short
   * default is what keeps this connection from ever making a read slower
   * than the one-shot baseline.
   */
  setBorrowTimeoutMs(timeoutMs: number): void {
    this.borrowTimeoutMs = timeoutMs;
  }

  /**
   * For one-shot scripts (Heroku Scheduler jobs, backfills) only: this
   * connection is lazy and otherwise lives for the whole process, so any
   * script that touches it (e.g. via fetchLivePrices) never exits — found
   * 2026-09-21, when the new-ticker pipeline's test run had to be killed. Waits
   * out an in-flight connect (it can finish after borrow() timed out), then
   * closes the API socket and SSH tunnel and suppresses the auto-reconnect.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.connecting?.catch(() => {});
    this.ib?.disconnect();
    this.tunnel?.close();
    this.ib = null;
    this.tunnel = null;
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
        setTimeout(() => reject(new Error(`Shared IBKR ${this.options.label} connection not ready within timeout.`)), this.borrowTimeoutMs);
      }),
    ]);

    if (!this.ib) throw new Error(`Shared IBKR ${this.options.label} connection not ready.`);
    const ib = this.ib;
    return { ib, release: () => {} };
  }

  private async connect(): Promise<void> {
    const connectStartedAt = Date.now();
    console.log(
      `IBKR shared ${this.options.label} connection: opening SSH tunnel to ${environment.ibkrTunnelSshHost}:${environment.ibkrTunnelSshPort} → ${environment.ibkrGatewayHost}:${ibkrGatewayPortByTradingMode[environment.ibkrTradingMode]}...`,
    );
    const sshPrivateKey = Buffer.from(environment.ibkrTunnelSshPrivateKeyBase64, "base64");

    const clientId = pickClientId(this.options.clientIdRangeStart, this.options.clientIdRangeSize);

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
        `IBKR shared ${this.options.label} connection: SSH tunnel open on local port ${tunnel.localPort} (${Date.now() - connectStartedAt}ms) — connecting to IBKR API with clientId ${clientId}...`,
      );

      const ib = new IBApi({ host: "127.0.0.1", port: tunnel.localPort, maxReqPerSec: this.options.maxRequestsPerSecond });

      await runIbkrHandshake(
        () =>
          new Promise<void>((resolve, reject) => {
            const onError = (error: Error, code: ErrorCode, reqId: number) => {
              if (reqId === -1) {
                console.log(`IBKR shared ${this.options.label} connection: informational status during connect: ${code} ${error.message}`);
                return;
              }
              console.error(`IBKR shared ${this.options.label} connection: connect failed with error ${code}: ${error.message} (after ${Date.now() - connectStartedAt}ms)`);
              cleanup();
              tunnel.close();
              reject(error);
            };
            const onConnected = () => {
              cleanup();
              resolve();
            };
            const timer = setTimeout(() => {
              console.error(`IBKR shared ${this.options.label} connection: connect timed out after ${Date.now() - connectStartedAt}ms waiting for nextValidId.`);
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
          }),
      );

      reqIdAllocatorByIb.set(ib, () => this.allocateReqId());

      if (this.options.fixedMarketDataType !== undefined) {
        markMarketDataTypeManaged(ib);
        ib.reqMarketDataType(this.options.fixedMarketDataType);
      }

      this.ib = ib;
      this.tunnel = tunnel;
      this.reconnectAttempt = 0;
      this.connectedSince = Date.now();
      console.log(
        `IBKR shared ${this.options.label} connection: connected (took ${Date.now() - connectStartedAt}ms total, lifetime reconnects=${this.totalReconnects}).`,
      );

      // Same reasoning as ibkrGatewayPersistentConnection.ts's post-connect
      // listener: reqId -1 carries broadcast connection-status notices
      // (market data farm up/down, etc.) that no per-request listener
      // catches, and this connection lives long enough for that to matter.
      ib.on(EventName.error, (error, code, reqId) => {
        if (reqId !== -1) return;
        console.log(`IBKR shared ${this.options.label} connection: system status ${code}: ${error.message}`);
      });

      ib.once(EventName.disconnected, () => this.handleDisconnect());
    } finally {
      this.connecting = null;
    }
  }

  private handleDisconnect(): void {
    if (this.reconnecting || this.shuttingDown) return;
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
      `IBKR shared ${this.options.label} connection dropped after ${uptimeMs !== null ? `${Math.round(uptimeMs / 1000)}s uptime` : "unknown uptime"} — reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}, lifetime reconnects=${this.totalReconnects}). Reads will fall back to one-shot connections until this recovers.`,
    );

    setTimeout(() => {
      this.reconnecting = false;
      // Routed through this.connecting (not a bare this.connect() call) so a
      // borrow() landing during this delay awaits this same attempt instead
      // of starting its own — found 2026-09-23: borrow()'s own
      // `if (!this.connecting) this.connecting = this.connect()` gate saw
      // this.connecting as null during the gap between a disconnect and this
      // scheduled retry firing, so it happily kicked off a second concurrent
      // connect() (its own tunnel + IBKR login, its own clientId) that raced
      // this one, and whichever settled last silently overwrote this.ib /
      // this.tunnel, leaking the other one's tunnel and login open forever.
      this.connecting = this.connect();
      this.connecting.catch((error) => {
        console.error(`IBKR shared ${this.options.label} connection reconnect failed: ${error instanceof Error ? error.message : error}`);
        this.handleDisconnect();
      });
    }, delay);
  }
}

/**
 * The shared connection when it is up (no per-call tunnel + handshake,
 * ~5 s), otherwise a one-shot connection — the pattern every request-time
 * IBKR caller should use (2026-09-24). Request ids on the shared connection
 * must come from nextReqIdFor; the returned `disconnect` releases either kind.
 */
export async function borrowSharedConnectionOrConnect(shared: SharedReadConnection, callerLabel: string): Promise<{ ib: IBApi; disconnect: () => void }> {
  try {
    const borrowed = await shared.borrow();
    return { ib: borrowed.ib, disconnect: borrowed.release };
  } catch (error) {
    console.log(`${callerLabel}: shared IBKR connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`);
    return connectToIbkrGateway();
  }
}

export const sharedReadConnection = new SharedReadConnection({
  label: "read",
  maxRequestsPerSecond: ibkrMessagesPerSecondBudget.sharedRead,
  clientIdRangeStart: 1_000_000,
  clientIdRangeSize: 500_000,
});

// For screens that hold long-lived live subscriptions (Ticker Detail). Kept
// apart from the read connection so its market data type is set once, to
// REALTIME, and never changed by another borrower — the read connection's
// borrowers flip it between FROZEN and REALTIME per request.
export const sharedLiveConnection = new SharedReadConnection({
  label: "live",
  maxRequestsPerSecond: ibkrMessagesPerSecondBudget.sharedLive,
  clientIdRangeStart: 1_500_000,
  clientIdRangeSize: 500_000,
  fixedMarketDataType: MarketDataType.REALTIME,
});
