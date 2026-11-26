// The daily-loss breaker trips on two readings past it, not one (Marcelo 2026-11-25). On staging on 25 Nov a single
// round read Pluto's book at -13.13% between readings of -7.37% and -7.34% (about $26,000 missing for one read) and
// tripped the breaker, which needs a person to reset it. A reading past the breaker now holds that round back (it sends
// nothing), and the breaker trips only when the readings stay past it for dailyLossConfirmSeconds. A reading that jumps
// dailyLossJumpPoints or more from the one before is logged with the book's parts, so the next such read shows its cause.

/** A run of readings past the breaker trips it once it has lasted this long: two readings at least this far apart. */
export const dailyLossConfirmSeconds = 15;
/** A reading this many percentage points or more from the one before is logged with every leg's value. */
export const dailyLossJumpPoints = 3;
/** Readings further apart than this (a night, a stopped agent) do not count as consecutive. */
export const dailyLossReadingsGapMs = 5 * 60_000;

export interface DailyLossReading {
  pct: number;
  atMs: number;
}

export interface DailyLossTrack {
  last: DailyLossReading | null;
  /** When the current run of readings past the breaker began; null when the last reading was not past it. */
  pastSinceMs: number | null;
}

export const emptyDailyLossTrack: DailyLossTrack = { last: null, pastSinceMs: null };

export interface DailyLossVerdict {
  track: DailyLossTrack;
  /** This reading is at or past the breaker (-breakerPct). */
  past: boolean;
  /** Past, and the run past it has lasted dailyLossConfirmSeconds: the breaker trips. */
  confirmed: boolean;
  /** The reading before, when this one is dailyLossJumpPoints or more away from it; otherwise null. */
  jumpedFromPct: number | null;
}

/**
 * Pure. Example (breaker 10%): -7.37% at 10:22:54, -13.13% at 10:23:18 (past, not confirmed: the round sends nothing,
 * and the 5.8-point jump is logged), -7.34% at 10:23:40 (not past: the run ends, nothing trips). Had the 10:23:40 reading
 * been -12%, 22 s into the run, the breaker would trip then.
 */
export function trackDailyLoss(track: DailyLossTrack, reading: DailyLossReading, breakerPct: number): DailyLossVerdict {
  const previous = track.last !== null && reading.atMs - track.last.atMs <= dailyLossReadingsGapMs ? track.last : null;
  const past = reading.pct <= -breakerPct;
  const pastSinceMs = past ? (previous !== null && track.pastSinceMs !== null ? track.pastSinceMs : reading.atMs) : null;
  const confirmed = past && pastSinceMs !== null && reading.atMs - pastSinceMs >= dailyLossConfirmSeconds * 1000;
  const jumpedFromPct = previous !== null && Math.abs(reading.pct - previous.pct) >= dailyLossJumpPoints ? previous.pct : null;
  return { track: { last: reading, pastSinceMs }, past, confirmed, jumpedFromPct };
}
