import type { RequestHandler } from "express";
import { broadcastToLocalSubscribers } from "./notificationBroadcaster.js";
import type { PulseEdgeId } from "./notificationChannel.js";

// Web-dyno-only animation signals for Iorio Pulse's topology map: lines whose
// activity is this process itself (browser requests, DB queries, Genosuke's
// LLM calls and chat storage). Delivered straight to the connected tabs in
// memory — deliberately NOT through Postgres NOTIFY, since a database round
// trip per pulse would itself be a database query and trigger the heroku-db
// pulse forever. Throttled per edge because the underlying activity (every
// request, every query) is far too frequent to draw one dot each.
const minimumIntervalMsByEdge: Record<PulseEdgeId, number> = {
  "heroku-browser": 500,
  "heroku-db": 1000,
  "genosuke-db": 500,
  "genosuke-llm": 500,
  "ibkr-gateway": 500,
};
const lastEmittedAtByEdge = new Map<PulseEdgeId, number>();

export function emitPulse(edgeId: PulseEdgeId): void {
  const now = Date.now();
  if (now - (lastEmittedAtByEdge.get(edgeId) ?? 0) < minimumIntervalMsByEdge[edgeId]) return;
  lastEmittedAtByEdge.set(edgeId, now);
  broadcastToLocalSubscribers({ type: "pulse", edgeId });
}

export const pulseOnRequestMiddleware: RequestHandler = (_request, _response, next) => {
  emitPulse("heroku-browser");
  next();
};
