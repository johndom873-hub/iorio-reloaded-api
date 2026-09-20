import { randomUUID } from "node:crypto";
import type { StreamProducerRegistry } from "./streamProducers.js";
import {
  isStreamKind,
  maxBufferedBytesPerConnection,
  maxConnectionsPerUser,
  maxQueuedEventFramesPerConnection,
  maxRememberedCancelledSubscriptionIds,
  maxSubscriptionsPerConnection,
  streamProtocolVersion,
  StreamRequestError,
  type StreamKind,
  type StreamServerFrame,
} from "./streamProtocol.js";

// What a connection needs from the transport under it (an Express response in
// production, a fake in tests) — keeps every rule below testable without HTTP.
export interface MultiplexedConnectionSink {
  /** Returns false when the transport's buffer is full (back-pressure). */
  write(serializedChunk: string): boolean;
  getBufferedByteCount(): number;
  end(): void;
}

export type SubscribeOutcome = "started" | "alreadyActive" | "ignoredBecauseCancelled";

interface ActiveSubscription {
  kind: StreamKind;
  abortController: AbortController;
}

/**
 * One browser tab's single SSE connection and every subscription running on
 * it. Each subscription is one producer invocation with its own AbortSignal,
 * so closing the connection (tab closed, network lost, dyno restarting) or
 * unsubscribing goes through exactly the cleanup path a closed legacy stream
 * request goes through today: the producer aborts and cancels its IBKR
 * market-data lines in its own `finally`.
 */
export class MultiplexedConnection {
  readonly connectionId = randomUUID();
  readonly openedAtMs = Date.now();

  private readonly activeSubscriptions = new Map<string, ActiveSubscription>();
  // Subscribe and unsubscribe are separate HTTP requests and can be applied
  // out of order; an unsubscribe that lands first is remembered so the late
  // subscribe for the same id is ignored instead of leaking a subscription.
  private readonly cancelledSubscriptionIds = new Set<string>();
  private isClosed = false;
  private isBackpressured = false;
  private readonly queuedEventFrames: string[] = [];
  private readonly latestSnapshotFrameBySubscriptionId = new Map<string, string>();

  constructor(
    readonly userId: string,
    private readonly sink: MultiplexedConnectionSink,
    private readonly producers: StreamProducerRegistry,
    private readonly onClosed: (connection: MultiplexedConnection) => void,
  ) {
    this.sendFrame({ type: "hello", connectionId: this.connectionId, protocolVersion: streamProtocolVersion }, false);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get subscriptionCountByKind(): Partial<Record<StreamKind, number>> {
    const counts: Partial<Record<StreamKind, number>> = {};
    for (const subscription of this.activeSubscriptions.values()) counts[subscription.kind] = (counts[subscription.kind] ?? 0) + 1;
    return counts;
  }

  subscribe(subscriptionId: string, rawKind: unknown, rawParameters: unknown): SubscribeOutcome {
    if (this.isClosed) throw new StreamRequestError(404, "Unknown stream connection.");
    if (this.cancelledSubscriptionIds.has(subscriptionId)) return "ignoredBecauseCancelled";
    if (this.activeSubscriptions.has(subscriptionId)) return "alreadyActive";
    if (!isStreamKind(rawKind)) throw new StreamRequestError(400, "Unknown stream kind.");

    const producer = this.producers[rawKind];
    const parameters = producer.parseParameters(rawParameters);
    if (this.activeSubscriptions.size >= maxSubscriptionsPerConnection) {
      throw new StreamRequestError(429, "Too many subscriptions on this connection.");
    }

    const subscription: ActiveSubscription = { kind: rawKind, abortController: new AbortController() };
    this.activeSubscriptions.set(subscriptionId, subscription);
    void this.runSubscription(subscriptionId, subscription, () =>
      producer.run(parameters, { userId: this.userId }, (payload) => this.emitData(subscriptionId, subscription, producer.isSnapshotStream, payload), subscription.abortController.signal),
    );
    return "started";
  }

  unsubscribe(subscriptionId: string): void {
    const subscription = this.activeSubscriptions.get(subscriptionId);
    if (subscription) {
      this.activeSubscriptions.delete(subscriptionId);
      subscription.abortController.abort();
    }
    this.cancelledSubscriptionIds.add(subscriptionId);
    if (this.cancelledSubscriptionIds.size > maxRememberedCancelledSubscriptionIds) {
      const oldest = this.cancelledSubscriptionIds.values().next().value;
      if (oldest !== undefined) this.cancelledSubscriptionIds.delete(oldest);
    }
  }

  /** Called when the transport drains after back-pressure: oldest events first, then the newest state of each snapshot stream. */
  handleDrain(): void {
    if (this.isClosed) return;
    this.isBackpressured = false;
    while (this.queuedEventFrames.length > 0) {
      const next = this.queuedEventFrames.shift()!;
      if (!this.sink.write(next)) {
        this.isBackpressured = true;
        return;
      }
    }
    for (const [subscriptionId, serialized] of this.latestSnapshotFrameBySubscriptionId) {
      this.latestSnapshotFrameBySubscriptionId.delete(subscriptionId);
      if (!this.sink.write(serialized)) {
        this.isBackpressured = true;
        return;
      }
    }
  }

  sendHeartbeat(): void {
    if (this.isClosed || this.isBackpressured) return;
    this.sink.write(": ping\n\n");
  }

  /** Aborts every subscription (releasing their IBKR lines) and ends the transport. Safe to call more than once. */
  close(reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const subscription of this.activeSubscriptions.values()) subscription.abortController.abort();
    this.activeSubscriptions.clear();
    this.queuedEventFrames.length = 0;
    this.latestSnapshotFrameBySubscriptionId.clear();
    this.onClosed(this);
    if (reason !== "transport closed") console.log(`streamMultiplexer: closed connection ${this.connectionId} (${reason}).`);
    this.sink.end();
  }

  private emitData(subscriptionId: string, subscription: ActiveSubscription, isSnapshotStream: boolean, payload: unknown): void {
    if (subscription.abortController.signal.aborted || this.isClosed) return;
    this.sendFrame({ type: "data", subscriptionId, data: payload }, isSnapshotStream);
  }

  private async runSubscription(subscriptionId: string, subscription: ActiveSubscription, run: () => Promise<void>): Promise<void> {
    const { signal } = subscription.abortController;
    try {
      await run();
      // A producer that returns without being unsubscribed ended on its own;
      // the legacy streams only ever do that on failure, so say so.
      if (!signal.aborted) this.sendFrame({ type: "end", subscriptionId }, false);
    } catch (error) {
      if (!signal.aborted) {
        console.error(`streamMultiplexer: ${subscription.kind} subscription failed`, error);
        // Deliberately generic: the details are in the server log.
        this.sendFrame({ type: "error", subscriptionId, message: "The live stream failed." }, false);
      }
    } finally {
      if (this.activeSubscriptions.get(subscriptionId) === subscription) this.activeSubscriptions.delete(subscriptionId);
    }
  }

  private sendFrame(frame: StreamServerFrame, isSnapshotFrame: boolean): void {
    if (this.isClosed) return;
    const serialized = `data: ${JSON.stringify(frame)}\n\n`;

    if (!this.isBackpressured) {
      if (!this.sink.write(serialized)) this.isBackpressured = true;
      this.closeIfBacklogTooLarge();
      return;
    }

    // The transport is backed up. A snapshot frame carries the full current
    // state, so only the newest one per subscription is worth keeping; every
    // other frame keeps its order.
    if (isSnapshotFrame && frame.type === "data") {
      this.latestSnapshotFrameBySubscriptionId.set(frame.subscriptionId, serialized);
    } else {
      if ("subscriptionId" in frame) this.moveLatestSnapshotToEventQueue(frame.subscriptionId);
      this.queuedEventFrames.push(serialized);
    }
    this.closeIfBacklogTooLarge();
  }

  private moveLatestSnapshotToEventQueue(subscriptionId: string): void {
    const latest = this.latestSnapshotFrameBySubscriptionId.get(subscriptionId);
    if (latest === undefined) return;
    this.latestSnapshotFrameBySubscriptionId.delete(subscriptionId);
    this.queuedEventFrames.push(latest);
  }

  private closeIfBacklogTooLarge(): void {
    if (this.sink.getBufferedByteCount() > maxBufferedBytesPerConnection || this.queuedEventFrames.length > maxQueuedEventFramesPerConnection) {
      this.close("unsent backlog too large");
    }
  }
}

const connectionsById = new Map<string, MultiplexedConnection>();

export function openMultiplexedConnection(userId: string, sink: MultiplexedConnectionSink, producers: StreamProducerRegistry): MultiplexedConnection {
  // A tab that reconnects after a network drop can arrive before the server
  // has noticed its old connection is dead; rather than lock that user out,
  // the oldest connection makes way.
  const userConnections = [...connectionsById.values()].filter((connection) => connection.userId === userId);
  if (userConnections.length >= maxConnectionsPerUser) {
    const oldestConnection = userConnections.sort((a, b) => a.openedAtMs - b.openedAtMs)[0];
    oldestConnection?.close("replaced by a newer connection");
  }
  const connection = new MultiplexedConnection(userId, sink, producers, (closed) => connectionsById.delete(closed.connectionId));
  connectionsById.set(connection.connectionId, connection);
  return connection;
}

/** Only ever returns a connection belonging to `userId`; another user's id looks exactly like an unknown one. */
export function findMultiplexedConnection(connectionId: string, userId: string): MultiplexedConnection | undefined {
  const connection = connectionsById.get(connectionId);
  return connection && connection.userId === userId ? connection : undefined;
}

export function getStreamMultiplexerStats(): { connectionCount: number; subscriptionCountByKind: Partial<Record<StreamKind, number>> } {
  const subscriptionCountByKind: Partial<Record<StreamKind, number>> = {};
  for (const connection of connectionsById.values()) {
    for (const [kind, count] of Object.entries(connection.subscriptionCountByKind) as [StreamKind, number][]) {
      subscriptionCountByKind[kind] = (subscriptionCountByKind[kind] ?? 0) + count;
    }
  }
  return { connectionCount: connectionsById.size, subscriptionCountByKind };
}
