import type { NextFunction, Request, Response } from "express";
import { isAuthenticatedSession } from "../lib/sessionAuthentication.js";
import { adminOnlyRefusal, disabledAccountRefusal, isAdminRequest, loadSessionUser } from "../lib/sessionUser.js";

/** Lets a signed-in, enabled user through and records who it is on request.sessionUser. */
export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  if (!isAuthenticatedSession(request.session)) {
    response.status(401).json({ error: "Not logged in." });
    return;
  }
  const user = await loadSessionUser(request.session.userId!);
  if (!user) {
    response.status(401).json({ error: "Not logged in." });
    return;
  }
  if (user.disabledAt) {
    request.session.destroy(() => {});
    response.status(401).json({ error: disabledAccountRefusal });
    return;
  }
  request.sessionUser = user;
  next();
}

/** After requireAuth: refuses a trader with 403. */
export function requireAdmin(request: Request, response: Response, next: NextFunction) {
  if (!isAdminRequest(request)) {
    response.status(403).json({ error: adminOnlyRefusal });
    return;
  }
  next();
}
