import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStreamMultiplexerRouter } from "./streamMultiplexer.js";
import type { StreamProducer, StreamProducerRegistry } from "../streams/streamProducers.js";
import { streamKinds } from "../streams/streamProtocol.js";

// A real Express app + real HTTP + a real SSE connection, with a fake session
// (the user id comes from a test header) and fake producers, so the routes,
// the wire format, ownership checks and the cleanup-on-disconnect path are
// exercised exactly as production runs them — minus IBKR and the database.

interface RecordedRun {
  userId: string;
  parameters: Record<string, string>;
  emit: (payload: unknown) => void;
  aborted: () => boolean;
}

const recordedRuns: RecordedRun[] = [];
const producer: StreamProducer = {
  isSnapshotStream: true,
  parseParameters: (raw) => ({ ...((raw as Record<string, string> | undefined) ?? {}) }),
  run: (parameters, context, emit, signal) =>
    new Promise<void>((resolve) => {
      recordedRuns.push({ userId: context.userId, parameters, emit, aborted: () => signal.aborted });
      signal.addEventListener("abort", () => resolve());
    }),
};
const producers = Object.fromEntries(streamKinds.map((kind) => [kind, producer])) as StreamProducerRegistry;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const userId = request.header("x-test-user");
    (request as unknown as { session: { userId?: string } }).session = { userId: userId ?? undefined };
    next();
  });
  app.use("/stream", createStreamMultiplexerRouter({ producers }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(path: string, userId: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": userId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

interface OpenStream {
  frames: Record<string, unknown>[];
  waitForFrame: (predicate: (frame: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
  close: () => void;
  connectionId: () => Promise<string>;
}

async function openStream(userId: string): Promise<OpenStream> {
  const abortController = new AbortController();
  const response = await fetch(`${baseUrl}/stream`, { headers: { "x-test-user": userId }, signal: abortController.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const frames: Record<string, unknown>[] = [];
  const waiters: { predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }[] = [];

  void (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        const parts = buffered.split("\n\n");
        buffered = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          const frame = JSON.parse(part.slice("data: ".length));
          frames.push(frame);
          for (const waiter of [...waiters]) {
            if (waiter.predicate(frame)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(frame);
            }
          }
        }
      }
    } catch {
      // aborted by the test
    }
  })();

  const waitForFrame = (predicate: (frame: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const existing = frames.find(predicate);
      if (existing) return resolve(existing);
      waiters.push({ predicate, resolve });
      setTimeout(() => reject(new Error("timed out waiting for a frame")), 2_000);
    });

  return {
    frames,
    waitForFrame,
    close: () => abortController.abort(),
    connectionId: async () => (await waitForFrame((frame) => frame.type === "hello")).connectionId as string,
  };
}

const eventually = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
};

describe("stream multiplexer routes", () => {
  it("requires a login on every route", async () => {
    expect((await fetch(`${baseUrl}/stream/status`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/stream`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/stream/anything/subscribe`, { method: "POST" })).status).toBe(401);
  });

  it("answers the compatibility handshake with the protocol version and the stream kinds it serves", async () => {
    const handshake = (await (await fetch(`${baseUrl}/stream/status`, { headers: { "x-test-user": "alice" } })).json()) as {
      protocolVersion: number;
      kinds: string[];
    };
    expect(handshake.protocolVersion).toBe(1);
    expect(handshake.kinds).toEqual(expect.arrayContaining(["greeks", "pnl", "exposure", "pricePerformancePrices", "tradeAlertPrices", "notifications", "pulses"]));
  });

  it("opens with a hello frame, then subscribe -> data -> unsubscribe works end to end", async () => {
    const stream = await openStream("alice");
    const connectionId = await stream.connectionId();

    const subscribed = await post(`/stream/${connectionId}/subscribe`, "alice", { subscriptionId: "greeks-subscription-1", kind: "greeks", parameters: { legIds: "leg" } });
    expect(subscribed).toEqual({ status: 202, body: { outcome: "started" } });
    await eventually(() => recordedRuns.some((run) => run.userId === "alice" && run.parameters.legIds === "leg"));
    const run = recordedRuns.find((candidate) => candidate.parameters.legIds === "leg")!;

    run.emit({ delta: 0.42 });
    expect(await stream.waitForFrame((frame) => frame.type === "data")).toEqual({ type: "data", subscriptionId: "greeks-subscription-1", data: { delta: 0.42 } });

    expect(await post(`/stream/${connectionId}/unsubscribe`, "alice", { subscriptionId: "greeks-subscription-1" })).toEqual({ status: 200, body: { ok: true } });
    await eventually(run.aborted);
    stream.close();
  });

  it("closing the SSE connection aborts every subscription on it (the cleanup path IBKR lines depend on)", async () => {
    const stream = await openStream("bob");
    const connectionId = await stream.connectionId();
    await post(`/stream/${connectionId}/subscribe`, "bob", { subscriptionId: "subscription-close-1", kind: "pnl", parameters: { positionIds: "close-a" } });
    await post(`/stream/${connectionId}/subscribe`, "bob", { subscriptionId: "subscription-close-2", kind: "greeks", parameters: { legIds: "close-b" } });
    await eventually(() => recordedRuns.filter((run) => run.parameters.positionIds === "close-a" || run.parameters.legIds === "close-b").length === 2);
    const runs = recordedRuns.filter((run) => run.parameters.positionIds === "close-a" || run.parameters.legIds === "close-b");
    expect(runs.some((run) => run.aborted())).toBe(false);

    stream.close();
    await eventually(() => runs.every((run) => run.aborted()));
  });

  it("does not let one user touch another user's connection", async () => {
    const stream = await openStream("carol");
    const connectionId = await stream.connectionId();
    expect((await post(`/stream/${connectionId}/subscribe`, "mallory", { subscriptionId: "hijack-subscription-1", kind: "greeks", parameters: {} })).status).toBe(404);
    expect((await post(`/stream/${connectionId}/unsubscribe`, "mallory", { subscriptionId: "hijack-subscription-1" })).status).toBe(404);
    stream.close();
  });

  it("answers 404 for an unknown connection (e.g. after a server restart) so the browser knows to reconnect", async () => {
    expect((await post("/stream/00000000-0000-0000-0000-000000000000/subscribe", "alice", { subscriptionId: "subscription-unknown", kind: "greeks", parameters: {} })).status).toBe(404);
  });

  it("validates the request: bad subscription id, unknown kind", async () => {
    const stream = await openStream("dave");
    const connectionId = await stream.connectionId();
    expect((await post(`/stream/${connectionId}/subscribe`, "dave", { subscriptionId: "x", kind: "greeks", parameters: {} })).status).toBe(400);
    expect((await post(`/stream/${connectionId}/subscribe`, "dave", { subscriptionId: "valid-subscription-id", kind: "orderQuote", parameters: {} })).status).toBe(400);
    expect((await post(`/stream/${connectionId}/subscribe`, "dave", {})).status).toBe(400);
    stream.close();
  });

  it("a late subscribe for an already-unsubscribed id is accepted but ignored", async () => {
    const stream = await openStream("erin");
    const connectionId = await stream.connectionId();
    await post(`/stream/${connectionId}/unsubscribe`, "erin", { subscriptionId: "raced-subscription-1" });
    const late = await post(`/stream/${connectionId}/subscribe`, "erin", { subscriptionId: "raced-subscription-1", kind: "greeks", parameters: { legIds: "raced" } });
    expect(late).toEqual({ status: 202, body: { outcome: "ignoredBecauseCancelled" } });
    expect(recordedRuns.some((run) => run.parameters.legIds === "raced")).toBe(false);
    stream.close();
  });
});
