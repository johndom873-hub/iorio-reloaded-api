import { db } from "../db/connection.js";

// Feeds Pulse's two charts (Total Unrealised P&L, Net Delta) across
// a page refresh or a brief outage — approved 2026-09-23 (previously an
// explicit tradeoff to keep no intraday history at all). Side-channel: the
// SSE handlers that already compute these values per subscription
// (streamPnlHandler, streamGreeksHandler in routes/positions.ts) call
// record*Sample() with their latest value on every update; nothing here
// triggers a new IBKR call. A value is written once a minute until it is
// sampleStaleAfterMs old: while Pulse is open the streams keep refreshing it
// (prices can update less than once a minute), and once no one has Pulse open,
// or a position closes and leaves the streams, its writes stop instead of
// repeating the last value until the dyno restarts (a flat line on the chart
// for hours no one watched).
//
// One flush per window rather than a write per call, same reasoning (and
// same table-lock incident) as priceService.ts's recordStockPrices: several
// concurrent Pulse tabs would otherwise fire independent upserts.
const flushIntervalMs = 60_000;
const rollingWindowMs = 8 * 60 * 60 * 1000;
export const sampleStaleAfterMs = 5 * 60_000;

interface PendingSample {
  value: number | null;
  recordedAtMs: number;
}

const pendingPnlByPositionId = new Map<string, PendingSample>();
const pendingDeltaByLegId = new Map<string, PendingSample>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureFlushTimerRunning(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => void flushPulseChartSamples(), flushIntervalMs);
  flushTimer.unref?.();
}

export function recordUnrealizedPnlSample(positionId: string, unrealizedPnl: number | null): void {
  pendingPnlByPositionId.set(positionId, { value: unrealizedPnl, recordedAtMs: Date.now() });
  ensureFlushTimerRunning();
}

export function recordLegDeltaSample(positionLegId: string, delta: number | null): void {
  pendingDeltaByLegId.set(positionLegId, { value: delta, recordedAtMs: Date.now() });
  ensureFlushTimerRunning();
}

/** Drops every sample last recorded sampleStaleAfterMs or longer ago; returns the rest. */
function freshSamples(pending: Map<string, PendingSample>, nowMs: number): [string, number | null][] {
  for (const [id, sample] of pending) {
    if (nowMs - sample.recordedAtMs >= sampleStaleAfterMs) pending.delete(id);
  }
  return [...pending].map(([id, sample]) => [id, sample.value]);
}

/** Writes the fresh samples and prunes rows past the rolling window, also when nothing is fresh. Exported for tests. */
export async function flushPulseChartSamples(nowMs: number = Date.now()): Promise<void> {
  const sampledAt = new Date(Math.floor(nowMs / flushIntervalMs) * flushIntervalMs);
  const cutoff = new Date(nowMs - rollingWindowMs);
  const pnlSamples = freshSamples(pendingPnlByPositionId, nowMs);
  const deltaSamples = freshSamples(pendingDeltaByLegId, nowMs);

  try {
    if (pnlSamples.length > 0) {
      const rows = pnlSamples.map(([positionId, unrealizedPnl]) => ({ position_id: positionId, sampled_at: sampledAt, unrealized_pnl: unrealizedPnl }));
      await db("pulse_unrealized_pnl_samples").insert(rows).onConflict(["position_id", "sampled_at"]).merge();
    }
    await db("pulse_unrealized_pnl_samples").where("sampled_at", "<", cutoff).del();
    if (deltaSamples.length > 0) {
      const rows = deltaSamples.map(([positionLegId, delta]) => ({
        position_leg_id: positionLegId,
        sampled_at: sampledAt,
        leg_delta: delta,
      }));
      await db("pulse_leg_delta_samples").insert(rows).onConflict(["position_leg_id", "sampled_at"]).merge();
    }
    await db("pulse_leg_delta_samples").where("sampled_at", "<", cutoff).del();
  } catch (error) {
    console.warn(`pulseChartSampleCollector: flush failed — ${error instanceof Error ? error.message : error}`);
  }
}
