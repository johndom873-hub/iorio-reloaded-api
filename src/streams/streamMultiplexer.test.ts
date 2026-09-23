import { describe, expect, it, vi } from "vitest";
import { findMultiplexedConnection, getStreamMultiplexerStats, openMultiplexedConnection, type MultiplexedConnectionSink } from "./streamMultiplexer.js";
import type { StreamProducer, StreamProducerRegistry } from "./streamProducers.js";
import { maxConnectionsPerUser, maxQueuedEventFramesPerConnection, maxSubscriptionsPerConnection, streamKinds, StreamRequestError } from "./streamProtocol.js";

class FakeSink implements MultiplexedConnectionSink {
  readonly chunks: string[] = [];
  isFull = false;
  bufferedByteCount = 0;
  hasEnded = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.isFull;
  }
  getBufferedByteCount(): number {
    return this.bufferedByteCount;
  }
  end(): void {
    this.hasEnded = true;
  }

  get frames(): Record<string, unknown>[] {
    return this.chunks.filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice("data: ".length)));
  }
}

interface ProducerRun {
  parameters: Record<string, string>;
  emit: (payload: unknown) => void;
  signal: AbortSignal;
  finishedCleanup: boolean;
  end: () => void;
  fail: (error: Error) => void;
}

// A producer that streams until aborted, like the real ones, and records every run.
function createControllableProducer(isSnapshotStream: boolean): { producer: StreamProducer; runs: ProducerRun[] } {
  const runs: ProducerRun[] = [];
  const producer: StreamProducer = {
    isSnapshotStream,
    parseParameters: (raw) => {
      if (raw !== undefined && (typeof raw !== "object" || raw === null)) throw new StreamRequestError(400, "bad parameters");
      return { ...(raw as Record<string, string>) };
    },
    run: (parameters, _context, emit, signal) =>
      new Promise<void>((resolve, reject) => {
        const run: ProducerRun = {
          parameters,
          emit,
          signal,
          finishedCleanup: false,
          end: () => resolve(),
          fail: (error) => reject(error),
        };
        runs.push(run);
        signal.addEventListener("abort", () => {
          run.finishedCleanup = true;
          resolve();
        });
      }),
  };
  return { producer, runs };
}

function createRegistry() {
  const snapshot = createControllableProducer(true);
  const events = createControllableProducer(false);
  const registry = Object.fromEntries(streamKinds.map((kind) => [kind, kind === "notifications" ? events.producer : snapshot.producer])) as StreamProducerRegistry;
  return { registry, snapshotRuns: snapshot.runs, eventRuns: events.runs };
}

let userCounter = 0;
function newUserId(): string {
  userCounter += 1;
  return `user-${userCounter}`;
}

function openConnection(overrides: { userId?: string } = {}) {
  const sink = new FakeSink();
  const { registry, snapshotRuns, eventRuns } = createRegistry();
  const connection = openMultiplexedConnection(overrides.userId ?? newUserId(), sink, registry);
  return { sink, connection, snapshotRuns, eventRuns, registry };
}

describe("MultiplexedConnection", () => {
  it("sends the hello frame first, carrying the connection id", () => {
    const { sink, connection } = openConnection();
    expect(sink.frames[0]).toEqual({ type: "hello", connectionId: connection.connectionId, protocolVersion: 1 });
    connection.close("test");
  });

  it("tags every data frame with its subscription id", () => {
    const { sink, connection, snapshotRuns } = openConnection();
    expect(connection.subscribe("subscription-one", "greeks", { legIds: "a" })).toBe("started");
    expect(connection.subscribe("subscription-two", "pnl", { positionIds: "b" })).toBe("started");
    snapshotRuns[0]!.emit({ delta: 0.5 });
    snapshotRuns[1]!.emit({ pnl: 12 });
    expect(sink.frames.slice(1)).toEqual([
      { type: "data", subscriptionId: "subscription-one", data: { delta: 0.5 } },
      { type: "data", subscriptionId: "subscription-two", data: { pnl: 12 } },
    ]);
    connection.close("test");
  });

  it("unsubscribe aborts the producer and stops its frames", () => {
    const { sink, connection, snapshotRuns } = openConnection();
    connection.subscribe("subscription-one", "greeks", {});
    connection.unsubscribe("subscription-one");
    expect(snapshotRuns[0]!.signal.aborted).toBe(true);
    const frameCountBefore = sink.frames.length;
    snapshotRuns[0]!.emit({ late: true });
    expect(sink.frames.length).toBe(frameCountBefore);
    // An unsubscribed producer finishing must not be reported as an unexpected end.
    expect(sink.frames.some((frame) => frame.type === "end")).toBe(false);
    connection.close("test");
  });

  it("ignores a subscribe that arrives after its own unsubscribe (requests can be applied out of order)", () => {
    const { connection, snapshotRuns } = openConnection();
    connection.unsubscribe("subscription-one");
    expect(connection.subscribe("subscription-one", "greeks", {})).toBe("ignoredBecauseCancelled");
    expect(snapshotRuns).toHaveLength(0);
    connection.close("test");
  });

  it("treats a repeated subscribe as a no-op instead of starting a second producer", () => {
    const { connection, snapshotRuns } = openConnection();
    expect(connection.subscribe("subscription-one", "greeks", {})).toBe("started");
    expect(connection.subscribe("subscription-one", "greeks", {})).toBe("alreadyActive");
    expect(snapshotRuns).toHaveLength(1);
    connection.close("test");
  });

  it("closing the connection aborts every subscription so each producer can release its resources", async () => {
    const { sink, connection, snapshotRuns, eventRuns } = openConnection();
    connection.subscribe("subscription-one", "greeks", {});
    connection.subscribe("subscription-two", "pnl", {});
    connection.subscribe("subscription-three", "notifications", {});
    connection.close("test");
    await Promise.resolve();
    expect([...snapshotRuns, ...eventRuns].every((run) => run.signal.aborted && run.finishedCleanup)).toBe(true);
    expect(sink.hasEnded).toBe(true);
    expect(findMultiplexedConnection(connection.connectionId, "anyone")).toBeUndefined();
  });

  it("reports a failing producer to its own subscription only, with a generic message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sink, connection, snapshotRuns } = openConnection();
    connection.subscribe("subscription-one", "greeks", {});
    connection.subscribe("subscription-two", "pnl", {});
    snapshotRuns[0]!.fail(new Error("relation \"secret_table\" does not exist"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const errorFrames = sink.frames.filter((frame) => frame.type === "error");
    expect(errorFrames).toEqual([{ type: "error", subscriptionId: "subscription-one", message: "The live stream failed." }]);
    // The neighbour keeps streaming.
    snapshotRuns[1]!.emit({ still: "alive" });
    expect(sink.frames.at(-1)).toEqual({ type: "data", subscriptionId: "subscription-two", data: { still: "alive" } });
    connection.close("test");
    consoleError.mockRestore();
  });

  it("reports a producer that ends on its own as an 'end' frame", async () => {
    const { sink, connection, snapshotRuns } = openConnection();
    connection.subscribe("subscription-one", "greeks", {});
    snapshotRuns[0]!.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.frames.at(-1)).toEqual({ type: "end", subscriptionId: "subscription-one" });
    connection.close("test");
  });

  it("rejects unknown kinds and invalid parameters without starting anything", () => {
    const { connection, snapshotRuns } = openConnection();
    expect(() => connection.subscribe("subscription-one", "orderQuote", {})).toThrow(StreamRequestError);
    expect(() => connection.subscribe("subscription-one", "greeks", "not-an-object")).toThrow(StreamRequestError);
    expect(snapshotRuns).toHaveLength(0);
    connection.close("test");
  });

  it("caps the subscriptions on one connection", () => {
    const { connection } = openConnection();
    for (let index = 0; index < maxSubscriptionsPerConnection; index++) connection.subscribe(`subscription-${index}`, "greeks", {});
    expect(() => connection.subscribe("one-too-many", "greeks", {})).toThrowError(expect.objectContaining({ httpStatus: 429 }));
    connection.close("test");
  });

  it("rejects subscribing on a closed connection", () => {
    const { connection } = openConnection();
    connection.close("test");
    expect(() => connection.subscribe("subscription-one", "greeks", {})).toThrowError(expect.objectContaining({ httpStatus: 404 }));
  });

  describe("back-pressure", () => {
    it("keeps only the newest frame per snapshot subscription while the transport is backed up, then delivers it on drain", () => {
      const { sink, connection, snapshotRuns } = openConnection();
      connection.subscribe("subscription-one", "greeks", {});
      connection.subscribe("subscription-two", "pnl", {});
      sink.isFull = true;
      snapshotRuns[0]!.emit({ n: 1 }); // written, but the transport reports it is now full
      snapshotRuns[0]!.emit({ n: 2 });
      snapshotRuns[0]!.emit({ n: 3 });
      snapshotRuns[1]!.emit({ m: 1 });
      snapshotRuns[1]!.emit({ m: 2 });
      const writtenWhileFull = sink.frames.length;
      sink.isFull = false;
      connection.handleDrain();
      const delivered = sink.frames.slice(writtenWhileFull);
      expect(delivered).toEqual([
        { type: "data", subscriptionId: "subscription-one", data: { n: 3 } },
        { type: "data", subscriptionId: "subscription-two", data: { m: 2 } },
      ]);
      connection.close("test");
    });

    it("never drops or reorders event-stream frames while backed up", () => {
      const { sink, connection, eventRuns } = openConnection();
      connection.subscribe("subscription-one", "notifications", {});
      sink.isFull = true;
      for (const n of [1, 2, 3, 4]) eventRuns[0]!.emit({ n });
      const writtenWhileFull = sink.frames.length;
      sink.isFull = false;
      connection.handleDrain();
      expect(sink.frames.slice(writtenWhileFull).map((frame) => (frame.data as { n: number }).n)).toEqual([2, 3, 4]);
      // n=1 was written immediately (that write is what reported the transport full).
      expect(sink.frames.map((frame) => (frame.data as { n?: number } | undefined)?.n).filter(Boolean)).toEqual([1, 2, 3, 4]);
      connection.close("test");
    });

    it("keeps a subscription's final snapshot ahead of its terminal frame", async () => {
      const { sink, connection, snapshotRuns } = openConnection();
      connection.subscribe("subscription-one", "greeks", {});
      sink.isFull = true;
      snapshotRuns[0]!.emit({ n: 1 });
      snapshotRuns[0]!.emit({ n: 2 });
      snapshotRuns[0]!.end();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const writtenWhileFull = sink.frames.length;
      sink.isFull = false;
      connection.handleDrain();
      expect(sink.frames.slice(writtenWhileFull)).toEqual([
        { type: "data", subscriptionId: "subscription-one", data: { n: 2 } },
        { type: "end", subscriptionId: "subscription-one" },
      ]);
      connection.close("test");
    });

    it("drops a connection whose unsent backlog grows without bound", () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const { sink, connection, eventRuns } = openConnection();
      connection.subscribe("subscription-one", "notifications", {});
      sink.isFull = true;
      for (let n = 0; n <= maxQueuedEventFramesPerConnection + 5; n++) eventRuns[0]!.emit({ n });
      expect(connection.closed).toBe(true);
      expect(sink.hasEnded).toBe(true);
      consoleLog.mockRestore();
    });

    it("drops a connection whose transport buffer is enormous", () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const { sink, connection, snapshotRuns } = openConnection();
      connection.subscribe("subscription-one", "greeks", {});
      sink.bufferedByteCount = 50 * 1024 * 1024;
      snapshotRuns[0]!.emit({ n: 1 });
      expect(connection.closed).toBe(true);
      consoleLog.mockRestore();
    });
  });

  it("sends heartbeats as real frames and skips them while the transport is backed up", () => {
    const { sink, connection, snapshotRuns } = openConnection();
    connection.sendHeartbeat();
    expect(sink.chunks.at(-1)).toBe(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`);

    connection.subscribe("subscription-one", "greeks", {});
    sink.isFull = true;
    snapshotRuns[0]!.emit({ n: 1 }); // this write reports the transport full
    const chunkCountWhileBackedUp = sink.chunks.length;
    connection.sendHeartbeat();
    expect(sink.chunks.length).toBe(chunkCountWhileBackedUp);
    connection.close("test");
  });
});

describe("connection registry", () => {
  it("only hands a connection to the user who owns it", () => {
    const { connection } = openConnection({ userId: "owner" });
    expect(findMultiplexedConnection(connection.connectionId, "owner")).toBe(connection);
    expect(findMultiplexedConnection(connection.connectionId, "someone-else")).toBeUndefined();
    expect(findMultiplexedConnection("no-such-connection", "owner")).toBeUndefined();
    connection.close("test");
  });

  it("makes the oldest connection give way once a user is at the cap, instead of locking them out", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const userId = newUserId();
    const connections = [];
    for (let index = 0; index < maxConnectionsPerUser; index++) connections.push(openConnection({ userId }).connection);
    // Distinguish "oldest" deterministically even when opened within the same millisecond.
    const newest = openConnection({ userId }).connection;
    expect(connections.filter((connection) => connection.closed)).toHaveLength(1);
    expect(newest.closed).toBe(false);
    [...connections, newest].forEach((connection) => connection.close("test"));
    consoleLog.mockRestore();
  });

  it("counts connections and subscriptions by kind for System Health", () => {
    const before = getStreamMultiplexerStats();
    const { connection } = openConnection();
    connection.subscribe("subscription-one", "greeks", {});
    connection.subscribe("subscription-two", "greeks", {});
    connection.subscribe("subscription-three", "pnl", {});
    const during = getStreamMultiplexerStats();
    expect(during.connectionCount).toBe(before.connectionCount + 1);
    expect(during.subscriptionCountByKind.greeks).toBe((before.subscriptionCountByKind.greeks ?? 0) + 2);
    expect(during.subscriptionCountByKind.pnl).toBe((before.subscriptionCountByKind.pnl ?? 0) + 1);
    connection.close("test");
    expect(getStreamMultiplexerStats().connectionCount).toBe(before.connectionCount);
  });
});
