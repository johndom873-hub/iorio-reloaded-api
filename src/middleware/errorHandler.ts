import type { ErrorRequestHandler } from "express";

// Catch-all for anything a route throws or rejects with. If the response has
// already started (headers sent), setting a status/body again throws
// ERR_HTTP_HEADERS_SENT — seen 2026-09-19 when a session-store failure landed
// mid-response — so hand it to Express's default handler, which just closes
// the connection.
export const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  console.error(error);
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(500).json({ error: "Something went wrong. Please try again." });
};
