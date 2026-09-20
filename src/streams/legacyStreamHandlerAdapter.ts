import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

// The five snapshot streams (greeks, P&L, exposure and the two price feeds)
// each already exist as an Express SSE handler that owns the whole job: the
// setup queries, the IBKR subscription, the never-regress-to-null caching and
// the cleanup when the client goes away. Rather than copy that logic into a
// second implementation that could drift, the multiplexer runs the very same
// handler function against a synthetic request/response pair and forwards
// every frame it writes. The handler cannot tell the difference, so the
// numbers a multiplexed subscription produces are the ones the legacy stream
// produces, by construction.
export type StreamHandler = (request: Request, response: Response) => Promise<void>;

export interface StreamHandlerInvocation {
  /** What the browser would have put in the legacy URL's query string. */
  query: Record<string, string>;
  userId: string;
}

class SyntheticStreamRequest extends EventEmitter {
  readonly params = {};
  readonly session: { userId: string };
  private hasClosed = false;

  constructor(
    readonly query: Record<string, string>,
    userId: string,
  ) {
    super();
    this.session = { userId };
  }

  close() {
    this.hasClosed = true;
    this.emit("close");
  }

  // The legacy handlers register `request.on("close", ...)` only AFTER their
  // setup queries finish. A real socket can't lose that race in practice, but
  // an unsubscribe can arrive in exactly that window, so a listener added
  // after the close is called straight away instead of never.
  override on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(eventName, listener);
    if (eventName === "close" && this.hasClosed) queueMicrotask(() => listener());
    return this;
  }
}

class SyntheticStreamResponse extends EventEmitter {
  private hasEnded = false;

  constructor(private readonly onDataFrame: (payload: unknown) => void) {
    super();
  }

  get writableEnded(): boolean {
    return this.hasEnded;
  }

  setHeader() {
    return this;
  }

  flushHeaders() {}

  write(chunk: string): boolean {
    if (this.hasEnded) return true;
    // The handlers write exactly one SSE frame per call: either
    // `data: <json>\n\n` or a `: ping\n\n` heartbeat comment (ignored — the
    // multiplexer runs its own heartbeat on the real connection).
    for (const part of String(chunk).split("\n\n")) {
      if (!part.startsWith("data: ")) continue;
      this.onDataFrame(JSON.parse(part.slice("data: ".length)));
    }
    return true;
  }

  end() {
    this.hasEnded = true;
  }
}

/**
 * Runs `handler` as a subscription: resolves when the handler finishes (which
 * it does once `signal` aborts and it has released its IBKR subscriptions, or
 * on its own if the stream ended). Rejects if the handler throws before it
 * starts streaming, e.g. a setup query failing.
 */
export async function runStreamHandlerAsProducer(
  handler: StreamHandler,
  invocation: StreamHandlerInvocation,
  emit: (payload: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const syntheticRequest = new SyntheticStreamRequest(invocation.query, invocation.userId);
  const syntheticResponse = new SyntheticStreamResponse(emit);

  const closeRequestOnAbort = () => syntheticRequest.close();
  if (signal.aborted) closeRequestOnAbort();
  else signal.addEventListener("abort", closeRequestOnAbort, { once: true });

  try {
    await handler(syntheticRequest as unknown as Request, syntheticResponse as unknown as Response);
  } finally {
    signal.removeEventListener("abort", closeRequestOnAbort);
  }
}
