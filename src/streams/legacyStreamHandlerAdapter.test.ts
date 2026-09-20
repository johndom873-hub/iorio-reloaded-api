import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { runStreamHandlerAsProducer, type StreamHandler } from "./legacyStreamHandlerAdapter.js";

// A handler written the way the real legacy stream handlers are: headers,
// `response.on("error")`, a setup await BEFORE `request.on("close")` is
// registered, a heartbeat comment, frames via response.write, and
// `response.end()` in a finally once aborted.
function createLegacyStyleHandler(behaviour: { setupDelayMs?: number; throwDuringSetup?: boolean; endWithoutAbort?: boolean } = {}) {
  const observed = { query: undefined as unknown, userId: undefined as unknown, cleanedUp: false, sendFrame: (_data: unknown) => {} };
  const handler: StreamHandler = async (request: Request, response: Response) => {
    observed.query = request.query;
    observed.userId = request.session.userId;
    if (behaviour.setupDelayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.setupDelayMs));
    if (behaviour.throwDuringSetup) throw new Error("setup query failed");

    response.setHeader("Content-Type", "text/event-stream");
    response.flushHeaders();
    response.on("error", () => {});

    const abortController = new AbortController();
    request.on("close", () => abortController.abort());
    const send = (data: unknown) => {
      if (response.writableEnded) return;
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    observed.sendFrame = send;
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": ping\n\n");
    }, 5);

    try {
      send({ first: true });
      if (behaviour.endWithoutAbort) return;
      await new Promise<void>((resolve) => abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally {
      observed.cleanedUp = true;
      clearInterval(heartbeat);
      response.end();
    }
  };
  return { handler, observed };
}

describe("runStreamHandlerAsProducer", () => {
  it("passes the query and user to the handler and forwards each data frame as a parsed payload", async () => {
    const { handler, observed } = createLegacyStyleHandler();
    const emitted: unknown[] = [];
    const abortController = new AbortController();
    const finished = runStreamHandlerAsProducer(handler, { query: { legIds: "a,b" }, userId: "user-1" }, (payload) => emitted.push(payload), abortController.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    observed.sendFrame({ second: 2 });
    abortController.abort();
    await finished;
    expect(observed.query).toEqual({ legIds: "a,b" });
    expect(observed.userId).toBe("user-1");
    expect(emitted).toEqual([{ first: true }, { second: 2 }]);
  });

  it("ignores the handler's heartbeat comments (the multiplexer runs its own)", async () => {
    const { handler } = createLegacyStyleHandler();
    const emitted: unknown[] = [];
    const abortController = new AbortController();
    const finished = runStreamHandlerAsProducer(handler, { query: {}, userId: "u" }, (payload) => emitted.push(payload), abortController.signal);
    await new Promise((resolve) => setTimeout(resolve, 40)); // several 5ms heartbeats
    abortController.abort();
    await finished;
    expect(emitted).toEqual([{ first: true }]);
  });

  it("aborting makes the handler run its own cleanup and then resolves", async () => {
    const { handler, observed } = createLegacyStyleHandler();
    const abortController = new AbortController();
    const finished = runStreamHandlerAsProducer(handler, { query: {}, userId: "u" }, () => {}, abortController.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observed.cleanedUp).toBe(false);
    abortController.abort();
    await finished;
    expect(observed.cleanedUp).toBe(true);
  });

  it("still aborts when the abort lands during the handler's setup, before it registers its close listener", async () => {
    const { handler, observed } = createLegacyStyleHandler({ setupDelayMs: 30 });
    const abortController = new AbortController();
    const finished = runStreamHandlerAsProducer(handler, { query: {}, userId: "u" }, () => {}, abortController.signal);
    setTimeout(() => abortController.abort(), 5); // long before the setup await completes
    await finished; // would hang forever if the close event were lost
    expect(observed.cleanedUp).toBe(true);
  });

  it("aborts immediately when the signal is already aborted", async () => {
    const { handler, observed } = createLegacyStyleHandler();
    const abortController = new AbortController();
    abortController.abort();
    await runStreamHandlerAsProducer(handler, { query: {}, userId: "u" }, () => {}, abortController.signal);
    expect(observed.cleanedUp).toBe(true);
  });

  it("rejects when the handler fails during setup, so the multiplexer can report it", async () => {
    const { handler } = createLegacyStyleHandler({ throwDuringSetup: true });
    await expect(runStreamHandlerAsProducer(handler, { query: {}, userId: "u" }, () => {}, new AbortController().signal)).rejects.toThrow("setup query failed");
  });

  it("resolves when the handler ends on its own, so an unexpected end can be reported", async () => {
    const { handler, observed } = createLegacyStyleHandler({ endWithoutAbort: true });
    const emitted: unknown[] = [];
    await runStreamHandlerAsProducer(handler, { query: {}, userId: "u" }, (payload) => emitted.push(payload), new AbortController().signal);
    expect(emitted).toEqual([{ first: true }]);
    expect(observed.cleanedUp).toBe(true);
  });

  it("stops forwarding frames once the handler has ended its response", async () => {
    const { handler, observed } = createLegacyStyleHandler({ endWithoutAbort: true });
    const emitted: unknown[] = [];
    await runStreamHandlerAsProducer(handler, { query: {}, userId: "u" }, (payload) => emitted.push(payload), new AbortController().signal);
    observed.sendFrame({ afterEnd: true });
    expect(emitted).toEqual([{ first: true }]);
  });
});
