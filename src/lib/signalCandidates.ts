import { blackScholesDelta, impliedVolatilityFromPrice, sviTotalVariance, type RawSviParameters, type SviSliceStatus } from "./impliedVolatilitySurface.js";
import { blackScholesVega, computeFrictionCost, computeNetEdge } from "./optionFriction.js";
import { computeUncompensatedShare, type UncompensatedShareOptions } from "./uncompensatedShare.js";
import { expirySpansEarnings, expirySpansEventDate, type RealizedVolatilityForecast } from "./volatilityEdge.js";

// Signals screen: turns one ticker's fitted surface (one row per expiry, from
// option_surface_fits) + that day's raw quotes into graded, tradable candidates.
// Approved 2026-09-22 (mockup): structural filters (OTM side, two-sided quote,
// >=1 day to expiry, a slice with status 'ok') plus, since 2026-09-24, two
// Signals-tab settings (max net delta, min annualised yield) — DTE window,
// spread or open interest still don't narrow the list; those show up as
// columns/flags instead. Delta and the surface-vs-mid IV comparison are both
// computed here (not read from IBKR's own tick-13 delta/IV), so every
// candidate has a number even where IBKR's own computation tick never arrived
// (~17% of contracts, see PROGRESS.md).

export type SignalStrategyKey = "covered_call" | "cash_secured_put";
export type SignalGrade = "strong" | "good" | "weak" | "avoid";
export type SignalFlag = "earnings_calendar_unresolved" | "outside_fitted_range" | "wide_spread" | "insufficient_cash" | "macro_event_before_expiry";

export const wideSpreadThreshold = 0.5; // matches the surface fit's own quote filter
const annualDays = 365;

export interface SignalSurfaceSliceDroppedCounts {
  inTheMoney: number;
  noTwoSidedQuote: number;
  spreadTooWide: number;
  noImpliedVolatility: number;
}

export interface SignalSurfaceSlice {
  expiry: string; // ISO date
  status: SviSliceStatus;
  parameters: RawSviParameters | null;
  kMin: number | null;
  kMax: number | null;
  yearsToExpiry: number;
  forwardPrice: number;
  /** Fit-quality diagnostics, surfaced for the volatility-surface modal; not consumed by scoring. */
  pointCount: number;
  rmseVolatility: number | null;
  minButterflyDensity: number | null;
  droppedCounts: SignalSurfaceSliceDroppedCounts;
  calendarChecks: number;
  calendarViolations: number;
}

/** live = a pooled IBKR subscription (modal / screen best line), day = the Day Signals refresh loop, snapshot = the 10:00 capture. */
export type SignalQuoteSource = "live" | "day" | "snapshot";

export interface SignalQuote {
  expiry: string; // ISO date, matches a slice's expiry
  strike: number;
  right: "C" | "P";
  bid: number | null;
  ask: number | null;
  /** Where bid/ask came from: the 10:00 capture (default), the Day Signals loop, or a live IBKR subscription. */
  source?: SignalQuoteSource;
  /** When a day/live quote was received (ISO); absent for the snapshot. */
  quotedAt?: string;
}

export interface SignalCandidatesInput {
  spotPrice: number;
  riskFreeRate: number;
  forecast: RealizedVolatilityForecast | null;
  slices: SignalSurfaceSlice[];
  quotes: SignalQuote[];
  earningsDatesIso: string[];
  /** False when the ticker has never resolved to a TradingView symbol, so earningsDatesIso is necessarily
   * empty regardless of what's actually scheduled -- candidates are still produced but flagged, not excluded
   * (Marcelo 2026-09-23: don't block on missing data, but surface that earnings risk is unchecked). */
  earningsCalendarResolved: boolean;
  /** Formula 3i (approved 2026-09-24): dates of major US macro releases (FOMC, CPI, jobs, PCE, GDP); a candidate whose
   * expiry spans one is FLAGGED, never excluded -- with one flat forecast per ticker, a short-dated IV spike into such a
   * date scores like mispricing, and the flag says so. See macroEventCalendar.ts for the curated list. */
  macroEventDatesIso: string[];
  snapshotDateIso: string;
  /** Free (uncovered) shares available for a covered call. */
  freeShares: number;
  /** Free cash available to secure a put. */
  freeCash: number;
  /** Signals tab setting: candidates with |delta| above this are filtered out. */
  maxNetDelta: number;
  /** Signals tab setting: candidates with annualised yield (as a %) below this are filtered out. */
  minAnnualizedYieldPct: number;
  /** Formula 3h (approved 2026-09-24): per-expiry parallel shift added to the surface IV, from computeExpiryIvShifts. */
  ivShiftByExpiry?: Map<string, number>;
}

export interface SignalCandidate {
  strategyKey: SignalStrategyKey;
  expiry: string;
  strike: number;
  dte: number;
  delta: number;
  bid: number;
  ask: number;
  spreadPercent: number;
  surfaceImpliedVolatility: number;
  midImpliedVolatility: number | null;
  forecastVolatility: number;
  edge: number;
  frictionVolatility: number;
  netEdge: number;
  /** net Edge x vega x 100 (Marcelo approved 2026-09-22). */
  edgeDollars: number;
  vega: number;
  /** Best case for an Adaptive order that fills at the mid: only the commission is conceded. */
  netEdgeAtMid: number;
  edgeDollarsAtMid: number;
  /** Max theoretical loss per contract at the mid premium: strike*100-premium (CSP) or spot*100-premium (CC). Marcelo approved 2026-09-23. */
  dollarRisk: number;
  /** edgeDollars / dollarRisk. */
  riskAdjustedRatio: number;
  /** edgeDollarsAtMid / dollarRisk. */
  riskAdjustedRatioAtMid: number;
  annualizedYield: number;
  uncompensatedSharePercent: number | null;
  quoteSource: SignalQuoteSource;
  /** When the quote behind bid/ask was received (day/live); null for the snapshot. */
  quotedAt: string | null;
  flags: SignalFlag[];
  executable: boolean;
  grade: SignalGrade; // filled in by gradeSignalCandidates; "avoid" until then
}

/** Mid-quote implied volatility through the surface library's own Black-76 inversion, so mid IV, surface IV and the fitter never disagree on pricing. */
export function impliedVolatilityFromMid(forward: number, strike: number, yearsToExpiry: number, riskFreeRate: number, bid: number, ask: number, isCall: boolean): number | null {
  return impliedVolatilityFromPrice((bid + ask) / 2, forward, strike, yearsToExpiry, riskFreeRate, isCall);
}

export const ivShiftMinimumQuotes = 5;

export interface ExpiryIvShift {
  /** Added to the surface IV of every strike in the expiry (a fraction: 0.021 = +2.1 vol points); 0 when too few quotes qualified. */
  shift: number;
  quoteCount: number;
}

/**
 * Formula 3h (approved 2026-09-24): for each expiry, the median of (mid IV − surface IV) over its fresh
 * (day/live) two-sided OTM quotes with spread ≤ 50% of the mid; requires ivShiftMinimumQuotes, else 0.
 * Without it the 10:00 surface never learned that the market was paying more (or less) for volatility
 * intraday — net Edge only moved through the friction term.
 */
export function computeExpiryIvShifts(slices: SignalSurfaceSlice[], quotes: SignalQuote[], riskFreeRate: number): Map<string, ExpiryIvShift> {
  const slicesByExpiry = new Map(slices.map((slice) => [slice.expiry, slice]));
  const differencesByExpiry = new Map<string, number[]>();
  for (const quote of quotes) {
    if (quote.source !== "day" && quote.source !== "live") continue;
    const slice = slicesByExpiry.get(quote.expiry);
    if (!slice || slice.status !== "ok" || !slice.parameters || !(slice.yearsToExpiry > 0)) continue;
    const isCall = quote.right === "C";
    if (isCall !== quote.strike >= slice.forwardPrice) continue;
    if (quote.bid === null || quote.ask === null || !(quote.bid > 0) || !(quote.ask > quote.bid)) continue;
    const mid = (quote.bid + quote.ask) / 2;
    if ((quote.ask - quote.bid) / mid > wideSpreadThreshold) continue;
    const totalVariance = sviTotalVariance(slice.parameters, Math.log(quote.strike / slice.forwardPrice));
    if (!(totalVariance > 0)) continue;
    const surfaceIv = Math.sqrt(totalVariance / slice.yearsToExpiry);
    const midIv = impliedVolatilityFromMid(slice.forwardPrice, quote.strike, slice.yearsToExpiry, riskFreeRate, quote.bid, quote.ask, isCall);
    if (midIv === null) continue;
    const differences = differencesByExpiry.get(quote.expiry) ?? [];
    differences.push(midIv - surfaceIv);
    differencesByExpiry.set(quote.expiry, differences);
  }
  const shifts = new Map<string, ExpiryIvShift>();
  for (const [expiry, differences] of differencesByExpiry) {
    shifts.set(expiry, { shift: differences.length >= ivShiftMinimumQuotes ? median(differences) : 0, quoteCount: differences.length });
  }
  return shifts;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Builds every structurally-eligible candidate for a ticker. Ungraded (grade is a placeholder "avoid" until gradeSignalCandidates runs). */
export function buildSignalCandidates(input: SignalCandidatesInput): SignalCandidate[] {
  const slicesByExpiry = new Map(input.slices.map((slice) => [slice.expiry, slice]));
  const candidates: SignalCandidate[] = [];

  for (const quote of input.quotes) {
    const slice = slicesByExpiry.get(quote.expiry);
    if (!slice || slice.status !== "ok" || !slice.parameters || slice.kMin === null || slice.kMax === null) continue;
    if (!(slice.yearsToExpiry > 0)) continue; // expiring today: excluded, same as the surface fitter -- also caught downstream by computeFrictionCost's vega guard, kept explicit for clarity

    const isCall = quote.right === "C";
    if (isCall !== quote.strike >= slice.forwardPrice) continue; // OTM side only
    if (quote.bid === null || quote.ask === null || !(quote.bid > 0) || !(quote.ask > quote.bid)) continue; // two-sided quote
    // Hard exclude, not a flag: don't offer a trade that spans a known earnings date (Marcelo 2026-09-23).
    // Matches generateTradeAlertCandidates.ts's calendar-conflict exclusion. Only excludes when the calendar
    // is actually resolved -- an unresolved ticker can't tell true "no earnings" apart from "unchecked", so
    // it falls through to the earnings_calendar_unresolved flag below instead of being silently allowed.
    if (input.earningsCalendarResolved && expirySpansEarnings(input.snapshotDateIso, quote.expiry, input.earningsDatesIso)) continue;

    const logMoneyness = Math.log(quote.strike / slice.forwardPrice);
    const totalVariance = sviTotalVariance(slice.parameters, logMoneyness);
    if (!(totalVariance > 0)) continue;
    const surfaceIv = Math.sqrt(totalVariance / slice.yearsToExpiry) + (input.ivShiftByExpiry?.get(quote.expiry) ?? 0);
    if (!(surfaceIv > 0)) continue;
    const midIv = impliedVolatilityFromMid(slice.forwardPrice, quote.strike, slice.yearsToExpiry, input.riskFreeRate, quote.bid, quote.ask, isCall);
    const delta = blackScholesDelta(slice.forwardPrice, quote.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv, isCall);
    if (Math.abs(delta) > input.maxNetDelta) continue; // Signals tab max net delta (approved 2026-09-24)
    const friction = computeFrictionCost({ bid: quote.bid, ask: quote.ask, forward: slice.forwardPrice, strike: quote.strike, yearsToExpiry: slice.yearsToExpiry, riskFreeRate: input.riskFreeRate, impliedVolatility: surfaceIv });
    if (!friction) continue;
    const edge = input.forecast ? surfaceIv - input.forecast.volatility : null;
    const netEdge = edge === null ? null : computeNetEdge({ impliedVolatility: surfaceIv, forecastVolatility: input.forecast!.volatility, forecastWindowDays: input.forecast!.windowDays, edge, insideFittedRange: true }, friction);
    if (netEdge === null) continue; // no forecast: unscored, not shown as a candidate at all (caller shows the ticker as "Unscored")
    const vega = blackScholesVega(slice.forwardPrice, quote.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv);
    const edgeDollars = netEdge * vega * 100;
    const netEdgeAtMid = edge! - friction.commissionVolatility;
    const edgeDollarsAtMid = netEdgeAtMid * vega * 100;

    const strategyKey: SignalStrategyKey = isCall ? "covered_call" : "cash_secured_put";
    const dte = Math.round(slice.yearsToExpiry * annualDays);
    const premium = (quote.bid + quote.ask) / 2;
    const capitalAtRisk = strategyKey === "covered_call" ? input.spotPrice : quote.strike;
    const annualizedYield = (premium / capitalAtRisk) * (annualDays / dte);
    if (annualizedYield * 100 < input.minAnnualizedYieldPct) continue; // Signals tab min annualised yield (approved 2026-09-24)
    const dollarRisk = capitalAtRisk * 100 - premium;
    const riskAdjustedRatio = edgeDollars / dollarRisk;
    const riskAdjustedRatioAtMid = edgeDollarsAtMid / dollarRisk;
    const spreadPercent = ((quote.ask - quote.bid) / premium) * 100;
    const insideRange = logMoneyness >= slice.kMin && logMoneyness <= slice.kMax;
    const flags: SignalFlag[] = [];
    if (!input.earningsCalendarResolved) flags.push("earnings_calendar_unresolved");
    if (!insideRange) flags.push("outside_fitted_range");
    if (spreadPercent / 100 > wideSpreadThreshold) flags.push("wide_spread");
    if (strategyKey === "cash_secured_put" && input.freeCash < quote.strike * 100) flags.push("insufficient_cash");
    if (expirySpansEventDate(input.snapshotDateIso, quote.expiry, input.macroEventDatesIso)) flags.push("macro_event_before_expiry");
    // A covered call always ships as one order (buy the shares, sell the call), so free shares
    // aren't a precondition -- only a cash-secured put needs the cash upfront.
    const executable = !flags.includes("insufficient_cash");

    candidates.push({
      strategyKey,
      expiry: quote.expiry,
      strike: quote.strike,
      dte,
      delta,
      bid: quote.bid,
      ask: quote.ask,
      spreadPercent,
      surfaceImpliedVolatility: surfaceIv,
      midImpliedVolatility: midIv,
      forecastVolatility: input.forecast!.volatility,
      edge: edge!,
      frictionVolatility: friction.frictionVolatility,
      netEdge,
      edgeDollars,
      vega,
      netEdgeAtMid,
      edgeDollarsAtMid,
      dollarRisk,
      riskAdjustedRatio,
      riskAdjustedRatioAtMid,
      annualizedYield,
      uncompensatedSharePercent: null,
      quoteSource: quote.source ?? "snapshot",
      quotedAt: quote.quotedAt ?? null,
      flags,
      executable,
      grade: "avoid",
    });
  }
  return candidates;
}

// UncompensatedShare is a Monte Carlo (~3 ms per candidate on the dyno at 1000 paths, 4x that at the
// default 4000), so it is NOT part of buildSignalCandidates: the Signals screen never needs it (only
// the modal shows it), and live re-scoring runs on every spot tick. Decided with Marcelo 2026-09-22
// after a laptop-vs-Basic-dyno benchmark: attach it only for the open modal's ticker, refreshed at
// most every 5 s and only after a >= 0.5% spot move, in a worker thread.
export const liveUncompensatedSharePathCount = 1000;
export const uncompensatedShareRefreshIntervalMs = 5_000;
export const uncompensatedShareRefreshSpotMoveFraction = 0.005;

export interface UncompensatedShareAttachInput {
  spotPrice: number;
  slices: SignalSurfaceSlice[];
}

/** Returns new candidate objects with uncompensatedSharePercent filled in (null where the slice is missing or the simulation degenerates). */
export function attachUncompensatedShare(candidates: SignalCandidate[], input: UncompensatedShareAttachInput, options: UncompensatedShareOptions = {}): SignalCandidate[] {
  const yearsByExpiry = new Map(input.slices.map((slice) => [slice.expiry, slice.yearsToExpiry]));
  return candidates.map((candidate) => {
    const yearsToExpiry = yearsByExpiry.get(candidate.expiry);
    if (yearsToExpiry === undefined) return { ...candidate, uncompensatedSharePercent: null };
    const shares = computeUncompensatedShare({ spotPrice: input.spotPrice, strike: candidate.strike, yearsToExpiry, volatility: candidate.surfaceImpliedVolatility }, options);
    return { ...candidate, uncompensatedSharePercent: shares ? shares.timingShare * 100 : null };
  });
}

// Grade cut points (approved 2026-09-24, replacing the old per-ticker quantile scale): fixed net
// Edge thresholds, in volatility points (netEdge is a fraction, so /100 here) -- net Edge <= 0 is
// avoid, 0-5vp is weak, 5-10vp is good, 10vp+ is strong.
// Exported so daySignalsNotifications.ts's notification hysteresis can offset the same cut points
// without duplicating the magic numbers.
export const strongCutVolatilityPoints = 10;
export const goodCutVolatilityPoints = 5;

/** The grade for a net Edge (a fraction): the same cut points grade a new-trade candidate and a roll (Formula 3j). */
export function gradeForNetEdge(netEdge: number): SignalGrade {
  const netEdgeVolatilityPoints = netEdge * 100;
  if (netEdge <= 0) return "avoid";
  if (netEdgeVolatilityPoints >= strongCutVolatilityPoints) return "strong";
  if (netEdgeVolatilityPoints >= goodCutVolatilityPoints) return "good";
  return "weak";
}

/** Assigns a grade to every candidate, in place conceptually (returns a new array), from its own net Edge. */
export function gradeSignalCandidates(candidates: SignalCandidate[]): SignalCandidate[] {
  return candidates.map((candidate) => ({ ...candidate, grade: gradeForNetEdge(candidate.netEdge) }));
}

/** The candidate the Signals screen shows as a ticker's headline: highest Edge $, ties broken by net Edge. */
export function pickBestCandidate(candidates: SignalCandidate[]): SignalCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.edgeDollars - a.edgeDollars || b.netEdge - a.netEdge)[0]!;
}
