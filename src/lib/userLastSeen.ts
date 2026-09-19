import { db } from "../db/connection.js";
import * as presenceTracker from "./presenceTracker.js";

// Iorio Pulse's Front End card only has room for this many users.
const presenceOverviewLimit = 3;

export interface PresenceOverviewUser {
  id: string;
  displayName: string;
  online: boolean;
  lastSeenAt: string | null;
}

/**
 * Stamps "now" as the user's last activity. Called on both connect and
 * disconnect of their /notifications/stream: the disconnect stamp is the real
 * "last active" time; the connect stamp keeps the value sensible when a dyno
 * restart drops connections without a disconnect event ever firing.
 */
export async function recordUserLastSeen(userId: string): Promise<void> {
  await db("users").where({ id: userId }).update({ last_seen_at: db.fn.now() });
}

/**
 * Online users first, then everyone else by most recent activity. Users with
 * no recorded activity and no open tab are left out — that is what keeps
 * non-human service users (e.g. the Genosuke bot, which never opens a tab)
 * from taking one of the few slots.
 */
export async function fetchPresenceOverview(): Promise<PresenceOverviewUser[]> {
  const onlineUserIds = new Set(presenceTracker.onlineUserIds());
  const rows: { id: string; displayName: string; lastSeenAt: Date | null }[] = await db("users").select(
    "id",
    "display_name as displayName",
    "last_seen_at as lastSeenAt",
  );
  return rows
    .filter((row) => onlineUserIds.has(row.id) || row.lastSeenAt !== null)
    .map((row) => ({ id: row.id, displayName: row.displayName, online: onlineUserIds.has(row.id), lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null }))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0) - (a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0);
    })
    .slice(0, presenceOverviewLimit);
}
