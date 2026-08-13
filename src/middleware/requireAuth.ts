import type { NextFunction, Request, Response } from "express";

export function requireAuth(request: Request, response: Response, next: NextFunction) {
  if (!request.session.userId) {
    response.status(401).json({ error: "Not logged in." });
    return;
  }
  next();
}
