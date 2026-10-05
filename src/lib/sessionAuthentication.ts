import type { Request } from "express";
import type { SessionData } from "express-session";
import { readPasskeyLoginMode } from "../config/passkeyLoginMode.js";

// With passkeys required, a session only counts as signed in when it was created by a passkey, or by the service
// account's loopback password login. A session without authMethod (created before passkeys were switched on) or a
// "password" session (created while the mode was off) is rejected, so flipping the mode needs no session wipe.
export function isAuthenticatedSession(session: Partial<Pick<SessionData, "userId" | "authMethod">>): boolean {
  if (!session.userId) return false;
  if (readPasskeyLoginMode() === "off") return true;
  return session.authMethod === "passkey" || session.authMethod === "service_password";
}

// A fresh session id whenever the authentication state changes (session fixation): whatever id the browser carried
// before is never the authenticated one.
export function regenerateSession(request: Request): Promise<void> {
  return new Promise<void>((resolve, reject) => request.session.regenerate((error) => (error ? reject(error) : resolve())));
}
