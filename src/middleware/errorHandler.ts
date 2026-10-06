import type { ErrorRequestHandler } from "express";

// Catch-all for anything a route throws or rejects with. If the response has
// already started (headers sent), setting a status/body again throws
// ERR_HTTP_HEADERS_SENT — seen 2026-09-19 when a session-store failure landed
// mid-response — so hand it to Express's default handler, which just closes
// the connection.
export const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    console.error(error);
    next(error);
    return;
  }
  // A malformed uuid in a route parameter reaches Postgres as a parse error
  // (code 22P02); that is "no such thing", not a server fault (2026-09-24).
  if ((error as { code?: string })?.code === "22P02") {
    response.status(404).json({ error: "Not found." });
    return;
  }
  // A request the body parser refused (oversized or malformed JSON) is the client's fault: answer with the parser's own 4xx,
  // never a server error, and without echoing anything from the request.
  const clientStatus = clientErrorStatus(error);
  if (clientStatus !== null) {
    response.status(clientStatus).json({ error: clientStatus === 413 ? "Request body is too large." : "Invalid request." });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Something went wrong. Please try again." });
};

function clientErrorStatus(error: unknown): number | null {
  const candidate = (error as { status?: unknown; statusCode?: unknown } | null | undefined)?.status ?? (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 499 ? candidate : null;
}
