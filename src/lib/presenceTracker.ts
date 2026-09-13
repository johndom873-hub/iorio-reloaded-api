// In-memory "who's currently using the app" tracker for Iorio Pulse's Front
// End node — reuses the connect/disconnect lifecycle of the existing
// /notifications/stream SSE connection every authenticated page already
// opens (BackgroundJobsContext.tsx), rather than a Pulse-specific heartbeat.
// "Online" therefore means "has any page of the app open right now," not
// "has Pulse open" (approved 2026-09-13). Memory-only, per-web-dyno-process —
// same intentional non-persistence as the job/alert/chat notifications this
// sits alongside; a dyno restart just means everyone briefly reads as
// offline until their tab's EventSource reconnects.
const connectionCountByUserId = new Map<string, number>();

export function connect(userId: string): string[] {
  connectionCountByUserId.set(userId, (connectionCountByUserId.get(userId) ?? 0) + 1);
  return onlineUserIds();
}

export function disconnect(userId: string): string[] {
  const current = connectionCountByUserId.get(userId) ?? 0;
  if (current <= 1) {
    connectionCountByUserId.delete(userId);
  } else {
    connectionCountByUserId.set(userId, current - 1);
  }
  return onlineUserIds();
}

export function onlineUserIds(): string[] {
  return [...connectionCountByUserId.keys()];
}

// For /system-health/web-dyno's "notification stream connections" count —
// deliberately the raw connection count (a user with two tabs open counts
// twice), not the distinct-user count onlineUserIds().length gives.
export function totalConnectionCount(): number {
  let total = 0;
  for (const count of connectionCountByUserId.values()) total += count;
  return total;
}
