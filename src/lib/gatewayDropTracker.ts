// Iorio Pulse's Gateway "drops" reading: connection drops of the worker's IBKR link over the last 24 hours, not counting the
// Gateway's daily planned restart. Every drop counts, including each failed retry of one outage (Marcelo 2026-10-05), so a long
// outage reads as a large number on purpose. Memory-only per worker process, like requestRateTracker.ts.

/** The Gateway's own daily auto-restart (IBC, 05:30 UTC) drops the connection for about 40 seconds; drops in this window are expected. */
export const plannedGatewayRestartWindow = { startUtcMinuteOfDay: 5 * 60 + 30, endUtcMinuteOfDay: 5 * 60 + 35 } as const;

export const unplannedDropWindowMs = 24 * 60 * 60_000;

/** Pure: whether a drop at this instant falls in the planned restart window (start inclusive, end exclusive). */
export function isWithinPlannedGatewayRestartWindow(dropTimeMs: number): boolean {
  const dropTime = new Date(dropTimeMs);
  const utcMinuteOfDay = dropTime.getUTCHours() * 60 + dropTime.getUTCMinutes();
  return utcMinuteOfDay >= plannedGatewayRestartWindow.startUtcMinuteOfDay && utcMinuteOfDay < plannedGatewayRestartWindow.endUtcMinuteOfDay;
}

export class UnplannedDropTracker {
  private unplannedDropTimesMs: number[] = [];

  /** Records a drop unless it falls in the planned restart window. Pruned here too, so the list stays small when nobody reads it. */
  recordDrop(dropTimeMs: number): void {
    this.pruneOlderThanWindow(dropTimeMs);
    if (isWithinPlannedGatewayRestartWindow(dropTimeMs)) return;
    this.unplannedDropTimesMs.push(dropTimeMs);
  }

  countInLast24Hours(nowMs: number): number {
    this.pruneOlderThanWindow(nowMs);
    return this.unplannedDropTimesMs.length;
  }

  private pruneOlderThanWindow(nowMs: number): void {
    this.unplannedDropTimesMs = this.unplannedDropTimesMs.filter((dropTimeMs) => nowMs - dropTimeMs < unplannedDropWindowMs);
  }
}
