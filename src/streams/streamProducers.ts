import { subscribeToNotifications } from "../lib/notificationBroadcaster.js";
import { publishNotification } from "../lib/notificationChannel.js";
import * as presenceTracker from "../lib/presenceTracker.js";
import { recordUserLastSeen } from "../lib/userLastSeen.js";
import { streamExposureHandler } from "../routes/riskLimits.js";
import { streamGreeksHandler, streamPnlHandler } from "../routes/positions.js";
import { streamPricePerformancePricesHandler } from "../routes/pricePerformance.js";
import { streamTradeAlertPricesHandler } from "../routes/tradeAlerts.js";
import { runStreamHandlerAsProducer, type StreamHandler } from "./legacyStreamHandlerAdapter.js";
import { StreamRequestError, type StreamKind } from "./streamProtocol.js";

export interface StreamProducerContext {
  userId: string;
}

export interface StreamProducer {
  /**
   * True when every frame carries the FULL current state (greeks, P&L,
   * exposure, prices), so under back-pressure an unsent frame can safely be
   * replaced by a newer one. False for event streams (notifications), where
   * every frame must be delivered in order.
   */
  isSnapshotStream: boolean;
  /** Validates what the browser sent and returns the normalized parameters; throws StreamRequestError. */
  parseParameters(rawParameters: unknown): Record<string, string>;
  /** Streams until `signal` aborts; every payload goes through `emit`. */
  run(parameters: Record<string, string>, context: StreamProducerContext, emit: (payload: unknown) => void, signal: AbortSignal): Promise<void>;
}

export type StreamProducerRegistry = Record<StreamKind, StreamProducer>;

const maxIdentifiersPerSubscription = 300;
const maxSymbolsPerSubscription = 200;
const identifierPattern = /^[0-9a-fA-F-]{36}$/;
const symbolPattern = /^[A-Za-z0-9.\-]{1,15}$/;

function readParameterObject(rawParameters: unknown): Record<string, unknown> {
  if (rawParameters === undefined || rawParameters === null) return {};
  if (typeof rawParameters !== "object" || Array.isArray(rawParameters)) {
    throw new StreamRequestError(400, "parameters must be an object.");
  }
  return rawParameters as Record<string, unknown>;
}

function requireNoParameters(rawParameters: unknown): Record<string, string> {
  const parameters = readParameterObject(rawParameters);
  if (Object.keys(parameters).length > 0) throw new StreamRequestError(400, "This stream takes no parameters.");
  return {};
}

function parseStringList(rawParameters: unknown, fieldName: string, pattern: RegExp, maximumCount: number): string[] {
  const parameters = readParameterObject(rawParameters);
  const extraFields = Object.keys(parameters).filter((key) => key !== fieldName);
  if (extraFields.length > 0) throw new StreamRequestError(400, `Unknown parameter: ${extraFields[0]}.`);
  const value = parameters[fieldName];
  if (!Array.isArray(value) || value.length === 0) throw new StreamRequestError(400, `${fieldName} must be a non-empty array.`);
  if (value.length > maximumCount) throw new StreamRequestError(400, `${fieldName} may hold at most ${maximumCount} entries.`);
  for (const entry of value) {
    if (typeof entry !== "string" || !pattern.test(entry)) throw new StreamRequestError(400, `${fieldName} contains an invalid entry.`);
  }
  return value as string[];
}

function handlerProducer(
  handler: StreamHandler,
  parseParameters: (rawParameters: unknown) => Record<string, string>,
): StreamProducer {
  return {
    isSnapshotStream: true,
    parseParameters,
    run: (query, context, emit, signal) => runStreamHandlerAsProducer(handler, { query, userId: context.userId }, emit, signal),
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

// Same presence bookkeeping the legacy /notifications/stream route does on
// connect/disconnect (presenceTracker + last-seen stamp + a presence frame to
// the Pulse dashboards): "online" means this user has a tab that is
// subscribed to notifications. Duplicated on purpose rather than shared with
// the legacy route so that route stays untouched until it is deleted.
function registerUserPresence(userId: string): () => void {
  const onlineAfterConnect = presenceTracker.connect(userId);
  recordUserLastSeen(userId)
    .catch((error) => console.error("recordUserLastSeen (multiplexer connect) failed:", error))
    .then(() => publishNotification({ type: "presence", onlineUserIds: onlineAfterConnect }))
    .catch(() => {});

  return () => {
    const onlineAfterDisconnect = presenceTracker.disconnect(userId);
    recordUserLastSeen(userId)
      .catch((error) => console.error("recordUserLastSeen (multiplexer disconnect) failed:", error))
      .then(() => publishNotification({ type: "presence", onlineUserIds: onlineAfterDisconnect }))
      .catch(() => {});
  };
}

export const streamProducers: StreamProducerRegistry = {
  greeks: handlerProducer(streamGreeksHandler, (rawParameters) => ({
    legIds: parseStringList(rawParameters, "legIds", identifierPattern, maxIdentifiersPerSubscription).join(","),
  })),
  pnl: handlerProducer(streamPnlHandler, (rawParameters) => ({
    positionIds: parseStringList(rawParameters, "positionIds", identifierPattern, maxIdentifiersPerSubscription).join(","),
  })),
  exposure: handlerProducer(streamExposureHandler, requireNoParameters),
  pricePerformancePrices: handlerProducer(streamPricePerformancePricesHandler, requireNoParameters),
  tradeAlertPrices: handlerProducer(streamTradeAlertPricesHandler, (rawParameters) => ({
    symbols: parseStringList(rawParameters, "symbols", symbolPattern, maxSymbolsPerSubscription).join(","),
  })),

  // Everything the legacy /notifications/stream sends except the
  // high-frequency topology pulses (those are the separate "pulses" kind, so
  // only the Pulse page's tab pays for them).
  notifications: {
    isSnapshotStream: false,
    parseParameters: requireNoParameters,
    async run(_parameters, context, emit, signal) {
      const unsubscribe = subscribeToNotifications((notification) => {
        if (notification.type !== "pulse") emit(notification);
      });
      const releasePresence = registerUserPresence(context.userId);
      try {
        await waitForAbort(signal);
      } finally {
        unsubscribe();
        releasePresence();
      }
    },
  },
  pulses: {
    isSnapshotStream: false,
    parseParameters: requireNoParameters,
    async run(_parameters, _context, emit, signal) {
      const unsubscribe = subscribeToNotifications((notification) => {
        if (notification.type === "pulse") emit(notification);
      });
      try {
        await waitForAbort(signal);
      } finally {
        unsubscribe();
      }
    },
  },
};
