import type { RequestHandler } from "express";

// Rolling request-rate counter for Iorio Pulse's Heroku node — no existing
// instrumentation for this anywhere in the app. Memory-only per dyno
// process, same non-persistence choice as presenceTracker.ts/llmStats.ts:
// a dashboard decoration, not a metrics pipeline.
const windowMs = 60_000;
let timestamps: number[] = [];

function pruneOlderThanWindow(now: number): void {
  timestamps = timestamps.filter((timestamp) => now - timestamp <= windowMs);
}

// Pruned on every push, not only when the Pulse page reads it — otherwise
// the array grows by one entry per request for as long as nobody opens Pulse.
export const requestRateMiddleware: RequestHandler = (_request, _response, next) => {
  const now = Date.now();
  pruneOlderThanWindow(now);
  timestamps.push(now);
  next();
};

export function requestRateStats(): { requestsPerMinute: number } {
  pruneOlderThanWindow(Date.now());
  return { requestsPerMinute: timestamps.length };
}

export const processStartedAt = new Date().toISOString();
