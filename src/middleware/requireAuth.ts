import type { NextFunction, Request, Response } from "express";
import { isAuthenticatedSession } from "../lib/sessionAuthentication.js";

export function requireAuth(request: Request, response: Response, next: NextFunction) {
  if (!isAuthenticatedSession(request.session)) {
    response.status(401).json({ error: "Not logged in." });
    return;
  }
  next();
}
