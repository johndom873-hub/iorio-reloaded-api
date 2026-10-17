import type { Request } from "express";
import { db } from "../db/connection.js";

// Who is behind a signed-in request, read from users on every request (requireAuth), so a change to a user's access level
// or a disable made in the database applies on their next request without signing them out.
//   admin   everything
//   trader  everything except changing risk limits or Pluto, lifting a trading halt, starting or resuming Pluto,
//           removing Shortlist tickers and restarting the IBKR Gateway; its opening and rolling orders are held to the
//           capital outside Pluto's budget and kept off the tickers Pluto trades (Marcelo 2026-10-17)

export type AccessLevel = "admin" | "trader";

export const accessLevels: readonly AccessLevel[] = ["admin", "trader"];

export interface SessionUser {
  id: string;
  displayName: string;
  accessLevel: AccessLevel;
  disabledAt: Date | null;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set by requireAuth for every request it lets through. */
    sessionUser?: SessionUser;
  }
}

export async function loadSessionUser(userId: string): Promise<SessionUser | null> {
  const row = await db("users").where({ id: userId }).first("id", "display_name", "access_level", "disabled_at");
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    // Fails closed: anything but an explicit admin is held to the trader's rules.
    accessLevel: row.access_level === "admin" ? "admin" : "trader",
    disabledAt: row.disabled_at ? new Date(row.disabled_at) : null,
  };
}

/** The signed-in user as every sign-in route and GET /auth/session answer it. */
export function authenticatedUserResponse(row: { id: string; username: string; display_name: string; access_level: string }) {
  return { id: row.id, username: row.username, displayName: row.display_name, accessLevel: (row.access_level === "admin" ? "admin" : "trader") as AccessLevel };
}

export const disabledAccountRefusal = "This account is disabled.";

/** Whether the request's user is an admin; false when requireAuth has not identified one. */
export function isAdminRequest(request: Request): boolean {
  return request.sessionUser?.accessLevel === "admin";
}

/** The refusal every admin-only action answers a trader with. */
export const adminOnlyRefusal = "Only an admin can do this.";
