import { db } from "../db/connection.js";

// Feeds Pulse's two charts (Total Unrealised P&L, Profit Probability) across
// a page refresh or a brief outage — approved 2026-09-23 (previously an
// explicit tradeoff to keep no intraday history at all). Side-channel: the
// SSE handlers that already compute these values per subscription
// (streamPnlHandler, streamGreeksHandler in routes/positions.ts) call
// record*Sample() with their latest value on every update; nothing here
// triggers a new IBKR call, so this costs nothing while no one has Pulse
// open — the caches just go stale and stop being flushed once the writers
// below prune old rows down to empty.
//
// One flush per window rather than a write per call, same reasoning (and
// same table-lock incident) as priceService.ts's recordStockPrices: several
// concurrent Pulse tabs would otherwise fire independent upserts.
const flushIntervalMs = 60_000;
const rollingWindowMs = 8 * 60 * 60 * 1000;

const pendingPnlByPositionId = new Map<string, number | null>();
const pendingProbabilityByLegId = new Map<string, number | null>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureFlushTimerRunning(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => void flush(), flushIntervalMs);
  flushTimer.unref?.();
}

export function recordUnrealizedPnlSample(positionId: string, unrealizedPnl: number | null): void {
  pendingPnlByPositionId.set(positionId, unrealizedPnl);
  ensureFlushTimerRunning();
}

export function recordProfitProbabilitySample(positionLegId: string, profitProbability: number | null): void {
  pendingProbabilityByLegId.set(positionLegId, profitProbability);
  ensureFlushTimerRunning();
}

async function flush(): Promise<void> {
  const sampledAt = new Date(Math.floor(Date.now() / flushIntervalMs) * flushIntervalMs);
  const cutoff = new Date(Date.now() - rollingWindowMs);

  try {
    if (pendingPnlByPositionId.size > 0) {
      const rows = [...pendingPnlByPositionId].map(([positionId, unrealizedPnl]) => ({ position_id: positionId, sampled_at: sampledAt, unrealized_pnl: unrealizedPnl }));
      await db("pulse_unrealized_pnl_samples").insert(rows).onConflict(["position_id", "sampled_at"]).merge();
      await db("pulse_unrealized_pnl_samples").where("sampled_at", "<", cutoff).del();
    }
    if (pendingProbabilityByLegId.size > 0) {
      const rows = [...pendingProbabilityByLegId].map(([positionLegId, profitProbability]) => ({
        position_leg_id: positionLegId,
        sampled_at: sampledAt,
        profit_probability: profitProbability,
      }));
      await db("pulse_profit_probability_samples").insert(rows).onConflict(["position_leg_id", "sampled_at"]).merge();
      await db("pulse_profit_probability_samples").where("sampled_at", "<", cutoff).del();
    }
  } catch (error) {
    console.warn(`pulseChartSampleCollector: flush failed — ${error instanceof Error ? error.message : error}`);
  }
}
