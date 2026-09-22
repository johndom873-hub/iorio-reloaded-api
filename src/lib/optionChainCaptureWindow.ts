// Which contracts the nightly option-chain archive captures (IORIO Signal
// Engine, Phase 0 — rule chosen 2026-09-21, artifact Formula 7).
//
// Per expiry, the strike window is ±w around spot, in log-moneyness:
//
//   w = clamp( 2 · IV_ATM · √(max(DTE, 1) / 365), 5%, 50% )
//
// i.e. two standard deviations of the expected move to that expiry, clamped.
// Chosen over a fixed ±25% because the contract count is about the same but a
// 0DTE window is ±5% instead of ±25% of dead strikes, and a 90-day window on a
// high-IV name reaches far enough to cover the strikes actually sold.
//
// Within the window each contract is captured on its out-of-the-money side
// only — puts below spot, calls above spot — plus the put AND call at the
// strike nearest spot (needed for the forward price and skew).

const standardDeviationsEitherSide = 2;
const minimumHalfWidth = 0.05;
const maximumHalfWidth = 0.5;
const calendarDaysPerYear = 365;

export interface StrikeWindowInput {
  spotPrice: number;
  /** Latest daily blended IBKR implied volatility as a decimal (0.84 = 84%). */
  atmImpliedVolatility: number;
  /** Calendar days to expiry; 0DTE is floored to 1 day for the width. */
  daysToExpiry: number;
}

export interface StrikeWindow {
  /** The clamped half-width w, as a fraction of spot in log terms. */
  halfWidth: number;
  lowerBound: number;
  upperBound: number;
}

/**
 * Null when an input is missing or non-physical (spot or IV not a positive
 * finite number, negative DTE). The caller decides what to do for a ticker
 * with no usable reference IV — this deliberately does not invent a fallback.
 */
export function computeStrikeWindow(input: StrikeWindowInput): StrikeWindow | null {
  const { spotPrice, atmImpliedVolatility, daysToExpiry } = input;
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;
  if (!Number.isFinite(atmImpliedVolatility) || atmImpliedVolatility <= 0) return null;
  if (!Number.isFinite(daysToExpiry) || daysToExpiry < 0) return null;

  const expectedMoveHalfWidth = standardDeviationsEitherSide * atmImpliedVolatility * Math.sqrt(Math.max(daysToExpiry, 1) / calendarDaysPerYear);
  const halfWidth = Math.min(maximumHalfWidth, Math.max(minimumHalfWidth, expectedMoveHalfWidth));
  return {
    halfWidth,
    lowerBound: spotPrice * Math.exp(-halfWidth),
    upperBound: spotPrice * Math.exp(halfWidth),
  };
}

export type CaptureOptionRight = "C" | "P";

export interface ContractToCapture {
  strike: number;
  right: CaptureOptionRight;
}

/** The listed strike nearest spot; an exact tie goes to the lower strike so the choice is deterministic. */
function nearestStrikeToSpot(strikes: number[], spotPrice: number): number | null {
  let nearest: number | null = null;
  for (const strike of strikes) {
    if (nearest === null) {
      nearest = strike;
      continue;
    }
    const distance = Math.abs(strike - spotPrice);
    const nearestDistance = Math.abs(nearest - spotPrice);
    if (distance < nearestDistance || (distance === nearestDistance && strike < nearest)) nearest = strike;
  }
  return nearest;
}

/**
 * The contracts to capture for one expiry: OTM puts and calls inside the
 * window, plus both rights at the strike nearest spot (even when that strike
 * sits just outside the window on a very coarse strike grid). Sorted by strike
 * then right, with no duplicates.
 */
export function selectContractsToCapture(availableStrikes: number[], spotPrice: number, window: StrikeWindow): ContractToCapture[] {
  const contractsByKey = new Map<string, ContractToCapture>();
  const add = (strike: number, right: CaptureOptionRight) => contractsByKey.set(`${strike}|${right}`, { strike, right });

  for (const strike of availableStrikes) {
    if (strike < spotPrice && strike >= window.lowerBound) add(strike, "P");
    if (strike > spotPrice && strike <= window.upperBound) add(strike, "C");
  }

  const atTheMoneyStrike = nearestStrikeToSpot(availableStrikes, spotPrice);
  if (atTheMoneyStrike !== null) {
    add(atTheMoneyStrike, "P");
    add(atTheMoneyStrike, "C");
  }

  return Array.from(contractsByKey.values()).sort((a, b) => a.strike - b.strike || a.right.localeCompare(b.right));
}

const millisecondsPerDay = 24 * 60 * 60 * 1000;

/**
 * Calendar days from an ISO trading date (YYYY-MM-DD, Eastern) to an IBKR
 * expiry (YYYYMMDD). Both are read as plain dates (UTC midnight), so DST and
 * the machine's timezone cannot shift the answer. Negative for a past expiry.
 */
export function calendarDaysUntilExpiry(todayIso: string, expiryYyyymmdd: string): number {
  const expiryIso = `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
  return Math.round((Date.parse(`${expiryIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / millisecondsPerDay);
}
