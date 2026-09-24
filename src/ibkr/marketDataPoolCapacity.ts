// Pure planning for marketDataPool.ts's shed-to-fit (approved 2026-09-24,
// "Fit" variant): when the shared budget hands the pool fewer lines than it
// has contracts, which subscriptions pause, and when lines come back, which
// resume. Shed order: option contracts before stock lines (stocks drive
// Pulse/Positions prices, Price Performance and the Signals screen; options
// drive per-leg greeks and the Ticker Detail chain), newest first within
// each group — the newest viewer loses out, not someone watching since the
// open. Resume order is the exact reverse.

export interface PoolCapacityEntry {
  poolKey: string;
  legType: "stock" | "option";
  /** Monotonic creation order — higher is newer. */
  sequence: number;
  paused: boolean;
}

export interface PoolCapacityPlan {
  pauseKeys: string[];
  resumeKeys: string[];
}

function shedPriority(entry: PoolCapacityEntry): number {
  // Sort ascending: the first entries are shed first.
  return (entry.legType === "option" ? 0 : 1) * 1e12 - entry.sequence;
}

export function planPoolCapacity(entries: PoolCapacityEntry[], allowedLines: number): PoolCapacityPlan {
  const active = entries.filter((entry) => !entry.paused);
  const paused = entries.filter((entry) => entry.paused);
  const target = Math.max(0, allowedLines);

  if (active.length > target) {
    const toPause = [...active].sort((a, b) => shedPriority(a) - shedPriority(b)).slice(0, active.length - target);
    return { pauseKeys: toPause.map((entry) => entry.poolKey), resumeKeys: [] };
  }
  const room = target - active.length;
  if (room > 0 && paused.length > 0) {
    const toResume = [...paused].sort((a, b) => shedPriority(b) - shedPriority(a)).slice(0, room);
    return { pauseKeys: [], resumeKeys: toResume.map((entry) => entry.poolKey) };
  }
  return { pauseKeys: [], resumeKeys: [] };
}
