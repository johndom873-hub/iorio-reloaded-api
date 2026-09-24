import type { Response } from "express";

export interface StreamedResult {
  /** The HTTP status the route would have sent as a plain response (200, 404, 422, ...). */
  status: number;
  /** The JSON body it would have sent — { error } for any status >= 400. */
  body: unknown;
}

const heartbeatIntervalMs = 15_000;

/**
 * Runs a request/response operation that can outlast Heroku's 30s router
 * timeout (H12: an IBKR chain quote, a Gateway restart, a per-expiry
 * contract-details refresh) as a Server-Sent Events response: headers go
 * out immediately, a comment heartbeat every 15s keeps the router's 55s
 * rolling idle window open, and the single final frame carries the exact
 * status + body a blocking JSON route would have answered with. The
 * frontend's apiStreamedRequest (api/client.ts) turns that frame back into
 * the same resolved value / ApiError as apiRequest, so callers are unchanged.
 * Failures inside `work` become a status-500 frame. The work always runs to
 * completion server-side, even if the client goes away — same as before.
 */
export async function respondWithStreamedResult(response: Response, work: () => Promise<StreamedResult>): Promise<void> {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, heartbeatIntervalMs);

  let result: StreamedResult;
  try {
    result = await work();
  } catch (error) {
    result = { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  } finally {
    clearInterval(heartbeat);
  }
  if (!response.writableEnded) {
    response.write(`data: ${JSON.stringify(result)}\n\n`);
    response.end();
  }
}
