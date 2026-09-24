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
  console.error(error);
  response.status(500).json({ error: "Something went wrong. Please try again." });
};
