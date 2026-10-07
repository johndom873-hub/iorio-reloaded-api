import { selectContractsToCapture, type StrikeWindow } from "./optionChainCaptureWindow.js";

// Which contracts the Day Signals loop quotes for each ticker, tracked to the LIVE spot
// (approved 2026-09-29, PROGRESS.md "DAY SIGNALS"). The 10:00 capture only stores the contracts that
// were out-of-the-money at the open; a stock that moves afterwards leaves a hole where the puts (or
// calls) it now wants to sell should be. Each cycle the loop re-applies the capture's own rule at the
// current spot, so the set stays the same size while it follows the price.

export interface DayContractRef {
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
}

export interface DayContractSetExpiry {
  expiry: string; // ISO date
  /** The real listed strike grid of this expiry. */
  strikes: number[];
  window: StrikeWindow;
}

export interface DayContractSetInput {
  expiries: DayContractSetExpiry[];
  spotPrice: number;
  /** The contracts quoted last time (their stored day quotes): kept for one strike step past the rule so a price hovering at a boundary does not add and drop the same contract every cycle. */
  previousContracts: DayContractRef[];
  /** Open short legs: always quoted, whatever side or window they sit in. */
  heldContracts: DayContractRef[];
}

function refKey(ref: DayContractRef): string {
  return `${ref.expiry}|${ref.strike}|${ref.right}`;
}

/** The listed strike spacing around spot (gap between the nearest strike at or below spot and the next one above); null when the grid does not straddle spot. */
export function strikeStepAroundSpot(strikes: number[], spotPrice: number): number | null {
  let below: number | null = null;
  let above: number | null = null;
  for (const strike of strikes) {
    if (strike <= spotPrice && (below === null || strike > below)) below = strike;
    if (strike > spotPrice && (above === null || strike < above)) above = strike;
  }
  return below !== null && above !== null ? above - below : null;
}

/**
 * Pure: per pooled expiry, selectContractsToCapture at the live spot (OTM puts and calls inside the window,
 * plus both rights at the strike nearest spot), plus the previous contracts still within one strike step of
 * the rule, plus the held contracts of those expiries. Sorted by expiry, strike, then right.
 */
export function selectDaySignalContractSet(input: DayContractSetInput): DayContractRef[] {
  const contractsByKey = new Map<string, DayContractRef>();
  const expiryByIso = new Map(input.expiries.map((entry) => [entry.expiry, entry]));

  for (const entry of input.expiries) {
    for (const contract of selectContractsToCapture(entry.strikes, input.spotPrice, entry.window)) {
      const ref = { expiry: entry.expiry, strike: contract.strike, right: contract.right };
      contractsByKey.set(refKey(ref), ref);
    }
  }

  for (const previous of input.previousContracts) {
    const entry = expiryByIso.get(previous.expiry);
    if (!entry || !entry.strikes.includes(previous.strike)) continue;
    const step = strikeStepAroundSpot(entry.strikes, input.spotPrice);
    if (step === null) continue;
    const insideBuffer =
      previous.right === "P"
        ? previous.strike < input.spotPrice + step && previous.strike >= entry.window.lowerBound - step
        : previous.strike > input.spotPrice - step && previous.strike <= entry.window.upperBound + step;
    if (insideBuffer) contractsByKey.set(refKey(previous), previous);
  }

  for (const held of input.heldContracts) {
    if (expiryByIso.has(held.expiry)) contractsByKey.set(refKey(held), held);
  }

  return [...contractsByKey.values()].sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.right.localeCompare(b.right));
}

// ---- Re-ranking the pooled expiries after a large move, and re-checking unpooled tickers ----
// Formula approved 2026-09-29: a ticker re-ranks when its spot has moved, since the last rank (initially
// the 10:00 capture spot), by at least max(1%, 0.5 x one-day expected move), where the one-day expected
// move is ATM IV / sqrt(252). Since 2026-10-07 (Marcelo): no daily cap (it went blind after three looks, exactly when a
// big mover's options get interesting); instead at least 15 minutes between two looks at the same ticker. A ticker the
// seed left unpooled is also re-checked on a clock, every 60 minutes since its last look (or since the loop first saw it
// that day), so an IV change without a price move is still caught. Every look re-references the spot.

export const daySignalsRerankMinimumMoveFraction = 0.01;
export const daySignalsRerankDailyMoveShare = 0.5;
export const daySignalsTradingDaysPerYear = 252;
export const daySignalsRerankMinimumGapMs = 15 * 60_000;
export const daySignalsUnpooledRecheckIntervalMs = 60 * 60_000;

export function daySignalsRerankTriggerFraction(atmImpliedVolatility: number): number {
  return Math.max(daySignalsRerankMinimumMoveFraction, (daySignalsRerankDailyMoveShare * atmImpliedVolatility) / Math.sqrt(daySignalsTradingDaysPerYear));
}

export interface RerankDecisionInput {
  spotPrice: number;
  /** Spot at the last look (the 10:00 capture spot until the first one). */
  referenceSpotPrice: number;
  atmImpliedVolatility: number;
  /** When the ticker was last re-ranked or re-checked today; null before its first look. Gates the 15-minute gap. */
  lastLookAtMs: number | null;
  /** When the loop first saw the ticker today: the hourly clock's start until its first look. */
  firstSeenAtMs: number | null;
  /** Whether the ticker has a pool (its contracts are quoted every cycle): only unpooled tickers get the timed re-check. */
  pooled: boolean;
  nowMs: number;
}

/** Pure: "price" when the move since the last look crossed the trigger, "timed" when an unpooled ticker is due its hourly look, else null. */
export function decideRerank(input: RerankDecisionInput): "price" | "timed" | null {
  if (!(input.spotPrice > 0) || !(input.referenceSpotPrice > 0) || !(input.atmImpliedVolatility > 0)) return null;
  const sinceLastLookMs = input.lastLookAtMs === null ? null : input.nowMs - input.lastLookAtMs;
  if (sinceLastLookMs !== null && sinceLastLookMs < daySignalsRerankMinimumGapMs) return null;
  const moveFraction = Math.abs(input.spotPrice - input.referenceSpotPrice) / input.referenceSpotPrice;
  // A hair of tolerance: (10.10 − 10) / 10 is 0.00999…96 in floating point, and a move of exactly the trigger must count.
  if (moveFraction >= daySignalsRerankTriggerFraction(input.atmImpliedVolatility) - 1e-9) return "price";
  const clockStartMs = input.lastLookAtMs ?? input.firstSeenAtMs;
  if (!input.pooled && clockStartMs !== null && input.nowMs - clockStartMs >= daySignalsUnpooledRecheckIntervalMs) return "timed";
  return null;
}
