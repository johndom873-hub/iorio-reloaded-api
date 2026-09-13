import type { RequestHandler } from "express";

// Rolling request-rate counter for Iorio Pulse's Heroku node — no existing
// instrumentation for this anywhere in the app. Memory-only per dyno
// process, same non-persistence choice as presenceTracker.ts/llmStats.ts:
// a dashboard decoration, not a metrics pipeline.
const windowMs = 60_000;
let timestamps: number[] = [];

export const requestRateMiddleware: RequestHandler = (_request, _response, next) => {
  timestamps.push(Date.now());
  next();
};

export function requestRateStats(): { requestsPerMinute: number } {
  const now = Date.now();
  timestamps = timestamps.filter((timestamp) => now - timestamp <= windowMs);
  return { requestsPerMinute: timestamps.length };
}

export const processStartedAt = new Date().toISOString();
