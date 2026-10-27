import { OptionType } from "@stoqey/ib";
import type { IBApi } from "@stoqey/ib";
import { blackScholesDelta } from "../lib/impliedVolatilitySurface.js";
import type { RecoveryTargetWindow } from "../lib/recoveryTargetWindow.js";
import { getRiskFreeRate } from "../lib/riskFreeRate.js";
import { loadCloseImpliedVolatilities } from "../lib/volatilityScreen.js";
import { fetchCalendarConflictContext, findCalendarConflict } from "./calendarConflict.js";
import { daysBetween, loadStoredOptionChain, parseExpiry, type ExpiryStrikes, type OptionQuote } from "./fetchOptionChain.js";
import { quoteContracts } from "./quoteContracts.js";

export interface CoveredCallCandidate {
  expiry: string; // YYYY-MM-DD
  strike: number;
  right: "call";
  delta: number;
  /** Mid of bid/ask, or the last price when the quote isn't two-sided. */
  premium: number;
  bid: number | null;
  ask: number | null;
  dte: number;
  annualizedYield: number;
  spotPrice: number;
  /**
   * True when the ticker has never resolved to a TradingView symbol, so its
   * earnings/ex-dividend calendar couldn't be checked — the candidate was NOT
   * excluded on that basis (absence of data isn't evidence of absence of an
   * event), but the caller should say so rather than imply a clean check.
   */
  calendarUnverified: boolean;
}

// Bounded to keep IBKR call volume predictable: only the nearest expiries
// inside the DTE window, and a percentage-of-spot strike band rather than a
// fixed nearest-N count — a 0.20-0.30 delta call can sit 10-12% OTM on a
// higher-IV underlying, so 40% covers it with margin. Capped at 50 strikes
// per expiry against pathologically fine strike grids.
const maxExpiriesToScan = 2;
const otmBandFraction = 0.4;
const maxStrikeCandidatesPerExpiry = 50;

// How far outside the delta band an estimated delta may sit and the strike
// still be quoted live: the estimate uses one 30-day IV for every strike and expiry.
export const estimatedDeltaMargin = 0.1;

function pickExpiriesInWindow(expirations: string[], dteMin: number, dteMax: number): string[] {
  const today = new Date();
  return expirations
    .filter((expiry) => {
      const dte = daysBetween(today, parseExpiry(expiry));
      return dte >= dteMin && dte <= dteMax;
    })
    .sort()
    .slice(0, maxExpiriesToScan);
}

/** Covered calls are sold out of the money: strikes above spot, nearest first. */
function pickOutOfTheMoneyCallStrikes(strikes: number[], spotPrice: number): number[] {
  return [...strikes]
    .sort((a, b) => a - b)
    .filter((strike) => strike > spotPrice && strike <= spotPrice * (1 + otmBandFraction))
    .slice(0, maxStrikeCandidatesPerExpiry);
}

function toIsoDate(expiryYyyymmdd: string): string {
  return `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
}

/** `${expiryYyyymmdd}|${strike}` → the call delta estimated before quoting. Empty when no estimate could be made. */
export type EstimatedCallDeltas = Map<string, number>;

export function estimatedCallDeltaKey(expiryYyyymmdd: string, strike: number): string {
  return `${expiryYyyymmdd}|${strike}`;
}

/**
 * Black-Scholes call deltas at IBKR's latest 30-day implied volatility, on the forward spot × e^(rT) (Marcelo 2026-10-27,
 * replacing the 10:00 ET capture's archived deltas). Empty without a stored IV.
 */
export function estimateCallDeltas(expiryStrikes: ExpiryStrikes[], input: { spotPrice: number; impliedVolatility: number | null; riskFreeRate: number; today: Date }): EstimatedCallDeltas {
  const estimates: EstimatedCallDeltas = new Map();
  if (input.impliedVolatility === null || !(input.impliedVolatility > 0)) return estimates;
  for (const { expiry, strikes } of expiryStrikes) {
    const yearsToExpiry = Math.max(daysBetween(input.today, parseExpiry(expiry)), 1) / 365;
    const forward = input.spotPrice * Math.exp(input.riskFreeRate * yearsToExpiry);
    for (const strike of strikes) estimates.set(estimatedCallDeltaKey(expiry, strike), blackScholesDelta(forward, strike, yearsToExpiry, input.riskFreeRate, input.impliedVolatility, true));
  }
  return estimates;
}

/**
 * Trims the strike band to the strikes whose estimated delta can plausibly land in the target band (approved
 * 2026-09-24, on the capture's deltas then) — the far wings were pure line cost. A strike with no estimate is kept
 * (absence is not evidence); with no estimate at all, the band is quoted in full.
 */
export function filterStrikesByEstimatedCallDelta(expiryStrikes: ExpiryStrikes[], targetWindow: { deltaTargetMin: number; deltaTargetMax: number }, estimated: EstimatedCallDeltas): ExpiryStrikes[] {
  if (estimated.size === 0) return expiryStrikes;
  const lower = targetWindow.deltaTargetMin - estimatedDeltaMargin;
  const upper = targetWindow.deltaTargetMax + estimatedDeltaMargin;
  return expiryStrikes
    .map(({ expiry, strikes }) => ({
      expiry,
      strikes: strikes.filter((strike) => {
        const delta = estimated.get(estimatedCallDeltaKey(expiry, strike));
        if (delta === undefined) return true;
        const magnitude = Math.abs(delta);
        return magnitude >= lower && magnitude <= upper;
      }),
    }))
    .filter(({ strikes }) => strikes.length > 0);
}

/**
 * Covered-call candidates for one ticker inside the covered_call delta/DTE
 * target window, ranked by annualized premium yield on the exposure net of the
 * premium (Marcelo 2026-10-12): annualizedYield = premium / (spot − premium) × (365 / dte). Drops any
 * expiry that would leave the call open across a known earnings or
 * ex-dividend date (calendarConflict.ts). Strike grids come from the stored
 * chain (the 09:00 UTC structure refresh), quotes from quoteContracts (pool first).
 * Used by the recovery-path projection, which only needs the top candidate.
 */
export async function scanRecoveryPathCoveredCallCandidates(ib: IBApi, symbol: string, tickerId: string, spotPrice: number, targetWindow: RecoveryTargetWindow): Promise<CoveredCallCandidate[]> {
  const chain = await loadStoredOptionChain(tickerId);
  if (chain.strikesByExpiry.size === 0) {
    console.warn(`${symbol}: option chain not prepared yet (no stored strike grids) — no covered-call candidates.`);
    return [];
  }
  const inWindow: ExpiryStrikes[] = pickExpiriesInWindow(chain.expirations, targetWindow.dteTargetMin, targetWindow.dteTargetMax)
    .map((expiry) => ({ expiry, strikes: pickOutOfTheMoneyCallStrikes(chain.strikesByExpiry.get(expiry) ?? [], spotPrice) }))
    .filter(({ strikes }) => strikes.length > 0);
  const [closeImpliedVolatilities, riskFreeRate] = await Promise.all([loadCloseImpliedVolatilities([tickerId]), getRiskFreeRate()]);
  const estimated = estimateCallDeltas(inWindow, { spotPrice, impliedVolatility: closeImpliedVolatilities.get(tickerId) ?? null, riskFreeRate: riskFreeRate ?? 0, today: new Date() });
  const expiryStrikes = filterStrikesByEstimatedCallDelta(inWindow, targetWindow, estimated);
  if (expiryStrikes.length === 0) return [];

  const [quotes, calendarContext] = await Promise.all([
    quoteContracts(ib, symbol, expiryStrikes.flatMap(({ expiry, strikes }) => strikes.map((strike) => ({ expiry, strike, right: OptionType.Call })))),
    fetchCalendarConflictContext(tickerId),
  ]);
  return rankCoveredCallCandidates(quotes, targetWindow, spotPrice, (expiryIso) => findCalendarConflict(calendarContext, "covered_call", expiryIso) !== null, !calendarContext.resolved);
}

function rankCoveredCallCandidates(
  quotes: OptionQuote[],
  targetWindow: RecoveryTargetWindow,
  spotPrice: number,
  expiryHasCalendarConflict: (expiryIso: string) => boolean,
  calendarUnverified: boolean,
): CoveredCallCandidate[] {
  const today = new Date();
  const candidates: CoveredCallCandidate[] = [];
  for (const quote of quotes) {
    if (quote.right !== OptionType.Call || quote.delta === null) continue;
    const deltaMagnitude = Math.abs(quote.delta);
    if (deltaMagnitude < targetWindow.deltaTargetMin || deltaMagnitude > targetWindow.deltaTargetMax) continue;

    const premium = quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : quote.last;
    if (premium === null || premium <= 0) continue;

    const dte = daysBetween(today, parseExpiry(quote.expiry));
    if (dte <= 0) continue;
    const expiryIso = toIsoDate(quote.expiry);
    if (expiryHasCalendarConflict(expiryIso)) continue;

    candidates.push({
      expiry: expiryIso,
      strike: quote.strike,
      right: "call",
      delta: quote.delta,
      premium,
      bid: quote.bid,
      ask: quote.ask,
      dte,
      annualizedYield: (premium / (spotPrice - premium)) * (365 / dte),
      spotPrice,
      calendarUnverified,
    });
  }
  return candidates.sort((a, b) => b.annualizedYield - a.annualizedYield);
}
