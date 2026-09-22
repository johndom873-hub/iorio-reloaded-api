// Wire protocol of the stream multiplexer (routes/streamMultiplexer.ts): ONE
// long-lived SSE connection per browser tab carries every live subscription
// that tab has open, so a tab never uses more than one of the browser's
// HTTP/1.1 connections per host. See PROGRESS.md "Stream multiplexing —
// design plan" for the reasoning behind every rule in this file.

export const streamProtocolVersion = 1;

// Every kind is backed by exactly one producer in streamProducers.ts. The
// money path (order-leg quote, roll/close contract quote, position quote,
// trade-alert run) is deliberately absent — those keep their own one-shot
// fail-closed streams (design decision D3).
export const streamKinds = [
  "greeks",
  "pnl",
  "exposure",
  "pricePerformancePrices",
  "tradeAlertPrices",
  "signalsScreen",
  "signalsTicker",
  "notifications",
  "pulses",
] as const;

export type StreamKind = (typeof streamKinds)[number];

export function isStreamKind(value: unknown): value is StreamKind {
  return typeof value === "string" && (streamKinds as readonly string[]).includes(value);
}

// Server -> browser frames, one JSON object per SSE `data:` line.
export type StreamServerFrame =
  // First frame on every connection; the browser needs the connectionId to
  // address its subscribe/unsubscribe calls.
  | { type: "hello"; connectionId: string; protocolVersion: number }
  | { type: "data"; subscriptionId: string; data: unknown }
  // The subscription failed (bad parameters found late, producer threw).
  // The subscription is gone; the browser decides what to show.
  | { type: "error"; subscriptionId: string; message: string }
  // The producer finished on its own without being unsubscribed — the legacy
  // streams only ever do that on failure, so the browser treats it like one.
  | { type: "end"; subscriptionId: string };

// Bounds that keep one misbehaving or very slow tab from hurting the dyno.
export const maxSubscriptionsPerConnection = 24;
export const maxConnectionsPerUser = 12;
export const maxRememberedCancelledSubscriptionIds = 500;
// A connection whose unsent backlog grows past either bound is dropped; the
// browser reconnects and resubscribes, and every snapshot stream starts with
// a full-state frame, so nothing is lost.
export const maxBufferedBytesPerConnection = 4 * 1024 * 1024;
export const maxQueuedEventFramesPerConnection = 2_000;

export class StreamRequestError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}
