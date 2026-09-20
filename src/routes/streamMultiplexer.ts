import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { findMultiplexedConnection, openMultiplexedConnection } from "../streams/streamMultiplexer.js";
import type { StreamProducerRegistry } from "../streams/streamProducers.js";
import { streamKinds, streamProtocolVersion, StreamRequestError } from "../streams/streamProtocol.js";

const heartbeatIntervalMs = 20_000;
const subscriptionIdPattern = /^[A-Za-z0-9_-]{8,64}$/;

export interface StreamMultiplexerRouterDependencies {
  producers: StreamProducerRegistry;
}

// ONE SSE connection per browser tab carries every live subscription the tab
// has open (see streams/streamProtocol.ts and PROGRESS.md "Stream
// multiplexing — design plan"). The browser learns its connectionId from the
// first frame and then adds/removes subscriptions with the two POST routes.
// Server state lives in memory in this process, so this needs the single web
// dyno the app runs on (or session affinity if it is ever scaled out) — the
// browser recovers from a restart by reconnecting and resubscribing.
export function createStreamMultiplexerRouter({ producers }: StreamMultiplexerRouterDependencies): Router {
  const router = Router();
  router.use(requireAuth);

  // A compatibility handshake: an API that has this route speaks the
  // multiplexer protocol; an older API answers 404, which tells a newer browser
  // (the front end and the API deploy separately) to use the legacy per-stream
  // connections instead of retrying forever. An EventSource can't read a body,
  // so this has to be a plain request made before the stream is opened.
  router.get("/status", (_request, response) => {
    response.json({ protocolVersion: streamProtocolVersion, kinds: streamKinds });
  });

  router.get("/", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    // A client that disconnects mid-write emits 'error' on the response; with
    // no listener Node treats that as uncaught and kills the process (see
    // tickerDetail.ts for the incident this guards against).
    response.on("error", () => {});

    const connection = openMultiplexedConnection(
      request.session.userId!,
      {
        write: (chunk) => (response.writableEnded ? true : response.write(chunk)),
        getBufferedByteCount: () => response.writableLength,
        end: () => {
          if (!response.writableEnded) response.end();
        },
      },
      producers,
    );
    response.on("drain", () => connection.handleDrain());
    const heartbeat = setInterval(() => connection.sendHeartbeat(), heartbeatIntervalMs);
    response.on("close", () => {
      clearInterval(heartbeat);
      connection.close("transport closed");
    });
  });

  router.post("/:connectionId/subscribe", (request, response) => {
    const connection = findMultiplexedConnection(request.params.connectionId, request.session.userId!);
    if (!connection) {
      response.status(404).json({ error: "Unknown stream connection." });
      return;
    }

    const { subscriptionId, kind, parameters } = (request.body ?? {}) as { subscriptionId?: unknown; kind?: unknown; parameters?: unknown };
    if (typeof subscriptionId !== "string" || !subscriptionIdPattern.test(subscriptionId)) {
      response.status(400).json({ error: "subscriptionId must be 8-64 characters of letters, digits, - or _." });
      return;
    }

    try {
      const outcome = connection.subscribe(subscriptionId, kind, parameters);
      response.status(202).json({ outcome });
    } catch (error) {
      if (!(error instanceof StreamRequestError)) throw error;
      response.status(error.httpStatus).json({ error: error.message });
    }
  });

  router.post("/:connectionId/unsubscribe", (request, response) => {
    const connection = findMultiplexedConnection(request.params.connectionId, request.session.userId!);
    if (!connection) {
      response.status(404).json({ error: "Unknown stream connection." });
      return;
    }

    const { subscriptionId } = (request.body ?? {}) as { subscriptionId?: unknown };
    if (typeof subscriptionId !== "string" || !subscriptionIdPattern.test(subscriptionId)) {
      response.status(400).json({ error: "subscriptionId must be 8-64 characters of letters, digits, - or _." });
      return;
    }

    connection.unsubscribe(subscriptionId);
    response.json({ ok: true });
  });

  return router;
}
