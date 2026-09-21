import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";

// TEMP diagnostic (2026-09-22): why the first Genosuke loopback call after every dyno
// restart gets a 401 on a freshly logged-in session. Logs short hashes, never raw ids.
export function sessionIdTag(sessionId: string | undefined): string {
  return sessionId ? createHash("sha1").update(sessionId).digest("hex").slice(0, 8) : "none";
}
function cookieSessionIdTag(cookieHeader: string | undefined): string {
  const match = cookieHeader?.match(/connect\.sid=s%3A([^.;]+)/);
  return sessionIdTag(match?.[1]);
}

export function requireAuth(request: Request, response: Response, next: NextFunction) {
  if (!request.session.userId) {
    if (request.ip === "127.0.0.1" || request.ip === "::1" || request.ip === "::ffff:127.0.0.1") {
      console.warn(`auth-diag: loopback 401 ${request.method} ${request.originalUrl} cookieSid=${cookieSessionIdTag(request.headers.cookie)} resolvedSid=${sessionIdTag(request.sessionID)} hasCookie=${Boolean(request.headers.cookie)}`);
    }
    response.status(401).json({ error: "Not logged in." });
    return;
  }
  next();
}
