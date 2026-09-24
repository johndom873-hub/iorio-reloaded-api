import { sviTotalVariance, yearsBetweenIsoDates } from "./impliedVolatilitySurface.js";
import { attachUncompensatedShare, buildSignalCandidates, computeExpiryIvShifts, gradeSignalCandidates, liveUncompensatedSharePathCount, pickBestCandidate, uncompensatedShareRefreshSpotMoveFraction, type SignalCandidate, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { buildRollCandidates, heldLegContractKey, pickBestRoll, scoreHeldLegs, type HeldLegScore, type RollSignalCandidate } from "./rollSignalCandidates.js";
import { buildTickerCaveats } from "./signalsRoadmap.js";
import type { SignalSettings } from "./signalSettingsStore.js";
import { skewMinimumDaysToExpiry, skewTargetDaysToExpiry } from "./tiltMeasures.js";
import type { AccountContext, DayQuotesAsOf, GradeCounts, PreviousClose, QuoteSourceCounts, SignalsPriceSource, SignalsScreenRow, TickerSignals, TickerSignalsInputs } from "./signalsTypes.js";

// Pure re-scoring for the Signals live layer (stage 2, decisions with Marcelo 2026-09-22):
// the fitted surface stays the 10:00 snapshot and follows the live spot by sticky
// moneyness (every expiry's forward scales with spot); live bid/ask replace the
// snapshot's only for the contracts the modal subscribes to (marked quoteSource
// "live"); frames go out at most once a second; account context refreshes every
// 60 s; UncompensatedShare is refreshed separately (worker thread, every 5 s after
// a >= 0.5% spot move) and carried across re-scores by contract key.

export const liveFrameIntervalMs = 1_000;
export const accountRefreshIntervalMs = 60_000;
export const liveQuoteMaxContracts = 40;

export interface ContractRef {
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
}

export interface LiveOptionQuote extends ContractRef {
  bid: number | null;
  ask: number | null;
  /** ISO time the quote was received; the pooled live path leaves it unset (the frame's `at` is the time). */
  quotedAt?: string;
}

export interface LiveScoringOverrides {
  spotPrice: number;
  priceSource: SignalsPriceSource;
  liveQuotes?: LiveOptionQuote[];
  /** Last Monte Carlo result per contract key; carried over so a re-score never blanks the column. */
  uncompensatedByContract?: Map<string, number | null>;
}

export function contractKey(ref: ContractRef): string {
  return `${ref.expiry}|${ref.strike}|${ref.right}`;
}

export function candidateContractKey(candidate: SignalCandidate): string {
  return contractKey({ expiry: candidate.expiry, strike: candidate.strike, right: candidate.strategyKey === "covered_call" ? "C" : "P" });
}

export function computeDayChangePercent(spotPrice: number | null, previousClose: PreviousClose | null): number | null {
  if (spotPrice === null || !previousClose || !(previousClose.close > 0)) return null;
  return (spotPrice / previousClose.close - 1) * 100;
}

/** Sticky moneyness: the 10:00 surface is re-read at the live spot by moving every expiry's forward in proportion. */
export function scaleSlicesToLiveSpot(slices: SignalSurfaceSlice[], snapshotSpot: number, liveSpot: number): SignalSurfaceSlice[] {
  if (!(snapshotSpot > 0) || !(liveSpot > 0) || liveSpot === snapshotSpot) return slices;
  const ratio = liveSpot / snapshotSpot;
  return slices.map((slice) => ({ ...slice, forwardPrice: slice.forwardPrice * ratio }));
}

/**
 * Fresh two-sided quotes replace the snapshot's bid/ask (source "live" or "day"); a fresh quote missing a
 * side leaves the existing quote in place. Applied day first, then live, so precedence is live > day > snapshot.
 */
export function mergeLiveQuotes(snapshotQuotes: SignalQuote[], liveQuotes: LiveOptionQuote[], source: "live" | "day" = "live"): SignalQuote[] {
  if (liveQuotes.length === 0) return snapshotQuotes;
  const liveByKey = new Map(liveQuotes.map((quote) => [contractKey(quote), quote]));
  return snapshotQuotes.map((quote) => {
    const live = liveByKey.get(contractKey(quote));
    if (!live || live.bid === null || live.ask === null) return quote;
    return { ...quote, bid: live.bid, ask: live.ask, source, quotedAt: live.quotedAt };
  });
}

/**
 * A held leg's contract is not always in the 10:00 snapshot (an ITM leg before the capture learned to include
 * open legs, or one outside the strike window), and mergeLiveQuotes only replaces snapshot rows. This appends
 * a fresh quote for any wanted contract the merged list lacks, live first, then day.
 */
export function appendMissingContractQuotes(quotes: SignalQuote[], wanted: ContractRef[], dayQuotes: LiveOptionQuote[], liveQuotes: LiveOptionQuote[]): SignalQuote[] {
  if (wanted.length === 0) return quotes;
  const present = new Set(quotes.map(contractKey));
  const liveByKey = new Map(liveQuotes.map((quote) => [contractKey(quote), quote]));
  const dayByKey = new Map(dayQuotes.map((quote) => [contractKey(quote), quote]));
  const appended: SignalQuote[] = [];
  for (const ref of wanted) {
    const key = contractKey(ref);
    if (present.has(key)) continue;
    const live = liveByKey.get(key);
    const day = dayByKey.get(key);
    const source: "live" | "day" | null = live && live.bid !== null && live.ask !== null ? "live" : day && day.bid !== null && day.ask !== null ? "day" : null;
    if (!source) continue;
    const fresh = source === "live" ? live! : day!;
    present.add(key);
    appended.push({ expiry: ref.expiry, strike: ref.strike, right: ref.right, bid: fresh.bid, ask: fresh.ask, source, quotedAt: fresh.quotedAt });
  }
  return appended.length === 0 ? quotes : [...quotes, ...appended];
}

export function countRollableLegs(rolls: RollSignalCandidate[]): number {
  return new Set(rolls.filter((roll) => roll.grade !== "avoid").map((roll) => roll.legId)).size;
}

export function summarizeDayQuotes(dayQuotes: LiveOptionQuote[]): DayQuotesAsOf | null {
  const times = dayQuotes.map((quote) => quote.quotedAt).filter((value): value is string => typeof value === "string");
  if (times.length === 0) return null;
  return { oldest: times.reduce((a, b) => (a < b ? a : b)), newest: times.reduce((a, b) => (a > b ? a : b)), count: times.length };
}

export function countQuoteSources(candidates: SignalCandidate[]): QuoteSourceCounts {
  const counts: QuoteSourceCounts = { live: 0, day: 0, snapshot: 0 };
  for (const candidate of candidates) counts[candidate.quoteSource] += 1;
  return counts;
}

/**
 * At-the-money IV of the 'ok' slice with at least 14 days left that is closest to 30 days (the same slice
 * computeSkew uses), read at log-moneyness 0. Under sticky moneyness this does not move with spot.
 */
export function computeAtmImpliedVolatility(slices: SignalSurfaceSlice[]): number | null {
  const eligible = slices.filter((slice) => slice.status === "ok" && slice.parameters && slice.yearsToExpiry * 365 >= skewMinimumDaysToExpiry);
  if (eligible.length === 0) return null;
  const nearest = eligible.reduce((best, slice) => (Math.abs(slice.yearsToExpiry * 365 - skewTargetDaysToExpiry) < Math.abs(best.yearsToExpiry * 365 - skewTargetDaysToExpiry) ? slice : best));
  const totalVariance = sviTotalVariance(nearest.parameters!, 0);
  return totalVariance > 0 ? Math.sqrt(totalVariance / nearest.yearsToExpiry) : null;
}

export function countGrades(candidates: SignalCandidate[]): GradeCounts {
  const counts: GradeCounts = { strong: 0, good: 0, weak: 0, avoid: 0 };
  for (const candidate of candidates) counts[candidate.grade] += 1;
  return counts;
}

/**
 * Re-times a surface fitted on an earlier day to today (2026-09-24): after a
 * missed capture the screen scored yesterday's slices with yesterday's
 * yearsToExpiry, so every DTE and yield was a day off and an expiry that
 * has since passed still appeared. Time to expiry is recomputed from today's
 * Eastern date; expiries already past are dropped. The SVI total variance is
 * scaled by T_today / T_fit (a and b are linear in it), which keeps every
 * strike's implied volatility exactly as fitted — only the time changes.
 * The alternative, leaving the total variance untouched, would inflate a
 * 7-day slice's IV by ~8% per elapsed day.
 */
export function rebaseSlicesToToday(slices: SignalSurfaceSlice[], todayEasternIso: string): SignalSurfaceSlice[] {
  const rebased: SignalSurfaceSlice[] = [];
  for (const slice of slices) {
    // Same convention as the fit itself (optionSurfaceFitting.ts): calendar days / 365.
    const yearsToExpiry = yearsBetweenIsoDates(todayEasternIso, slice.expiry);
    if (!(yearsToExpiry > 0)) continue;
    if (!(slice.yearsToExpiry > 0) || Math.abs(yearsToExpiry - slice.yearsToExpiry) < 1e-9) {
      rebased.push(slice);
      continue;
    }
    const scale = yearsToExpiry / slice.yearsToExpiry;
    rebased.push({
      ...slice,
      yearsToExpiry,
      parameters: slice.parameters ? { ...slice.parameters, a: slice.parameters.a * scale, b: slice.parameters.b * scale } : null,
    });
  }
  return rebased;
}

/** Scores one ticker from its loaded inputs; `live` re-reads the snapshot at the live spot and merges live quotes. */
export function scoreTicker(inputs: TickerSignalsInputs, account: AccountContext, settings: SignalSettings, live?: LiveScoringOverrides): TickerSignals {
  const { header } = inputs;
  const spotPrice = live?.spotPrice ?? header?.underlyingPrice ?? null;
  const base: Omit<TickerSignals, "unscoredReason"> = {
    tickerId: inputs.tickerId,
    symbol: inputs.symbol,
    companyName: inputs.companyName,
    sector: inputs.sector,
    snapshotDateIso: header?.tradingDateIso ?? null,
    snapshotCapturedAt: header?.capturedAt ?? null,
    spotPrice,
    priceSource: live?.priceSource ?? "snapshot",
    previousClose: inputs.previousClose,
    // Only a live/frozen price is "today's": the 10:00 snapshot spot vs that same day's close is not a day change.
    dayChangePercent: live && live.priceSource !== "snapshot" ? computeDayChangePercent(spotPrice, inputs.previousClose) : null,
    candidates: [],
    best: null,
    gradeCounts: { strong: 0, good: 0, weak: 0, avoid: 0 },
    heldLegs: scoreHeldLegs(inputs.openShortLegs, { spotPrice: spotPrice ?? 0, riskFreeRate: 0, forecast: null, slices: [], quotes: [] }),
    rolls: [],
    bestRoll: null,
    rollCount: 0,
    fittedSliceCount: inputs.slices.filter((slice) => slice.status === "ok").length,
    totalSliceCount: inputs.slices.length,
    momentum: inputs.momentum,
    skew: inputs.skew,
    elevatedVolatility: inputs.elevatedVolatility,
    nextEarningsDateIso: inputs.nextEarningsDateIso,
    macroEvents: inputs.macroEvents,
    atmImpliedVolatility: computeAtmImpliedVolatility(rebaseSlicesToToday(inputs.slices, inputs.todayEasternIso)),
    forecast: inputs.forecast,
    dailyBarCount: inputs.dailyBarCount,
    dividendCadenceUnknown: inputs.dividendCadenceUnknown,
    caveats: [],
    freeShares: inputs.freeShares,
    freeCash: account.freeCash,
    dayQuotesAsOf: summarizeDayQuotes(inputs.dayQuotes),
    ivShiftByExpiry: {},
    quoteSourceCounts: { live: 0, day: 0, snapshot: 0 },
  };
  const withCaveats = (unscoredReason: TickerSignals["unscoredReason"]): TickerSignals => ({
    ...base,
    unscoredReason,
    caveats: buildTickerCaveats({ unscoredReason, suspectedSplitDateIso: inputs.suspectedSplitDateIso, dailyBarCount: inputs.dailyBarCount, dividendCadenceUnknown: inputs.dividendCadenceUnknown, snapshotDateIso: base.snapshotDateIso }, inputs.todayEasternIso),
  });

  if (!header) return withCaveats("no_snapshot");
  if (base.fittedSliceCount === 0 || header.underlyingPrice === null || header.riskFreeRatePercent === null) return withCaveats("no_surface_fit");
  if (!inputs.forecast) return withCaveats(inputs.suspectedSplitDateIso !== null ? "suspected_split" : "no_forecast");
  if (spotPrice === null) return withCaveats("no_snapshot");

  const todaySlices = rebaseSlicesToToday(inputs.slices, inputs.todayEasternIso);
  const slices = live ? scaleSlicesToLiveSpot(todaySlices, header.underlyingPrice, live.spotPrice) : todaySlices;
  // Precedence per contract: pooled live (modal / screen best line) > day (refresh loop) > 10:00 snapshot.
  const withDayQuotes = mergeLiveQuotes(inputs.quotes, inputs.dayQuotes, "day");
  const mergedQuotes = live?.liveQuotes ? mergeLiveQuotes(withDayQuotes, live.liveQuotes, "live") : withDayQuotes;
  const heldLegRefs: ContractRef[] = inputs.openShortLegs.map((leg) => ({ expiry: leg.expiry, strike: leg.strike, right: leg.right }));
  const quotes = appendMissingContractQuotes(mergedQuotes, heldLegRefs, inputs.dayQuotes, live?.liveQuotes ?? []);
  const riskFreeRate = header.riskFreeRatePercent / 100;
  const ivShifts = computeExpiryIvShifts(slices, quotes, riskFreeRate);

  let candidates = gradeSignalCandidates(
    buildSignalCandidates({
      spotPrice,
      riskFreeRate,
      forecast: inputs.forecast,
      slices,
      quotes,
      earningsDatesIso: inputs.earningsDatesIso,
      earningsCalendarResolved: inputs.earningsCalendarResolved,
      macroEventDatesIso: [...new Set(inputs.macroEvents.map((event) => event.dateIso))],
      snapshotDateIso: header.tradingDateIso,
      freeShares: inputs.freeShares,
      freeCash: account.freeCash,
      maxNetDelta: settings.maxNetDelta,
      minAnnualizedYieldPct: settings.minAnnualizedYieldPct,
      ivShiftByExpiry: new Map([...ivShifts].map(([expiry, entry]) => [expiry, entry.shift])),
    }),
  );
  // settings.maxDeltaDriftPct is deliberately not applied: the drift share is only known for the open
  // modal's ticker (Monte Carlo), so filtering on it would make the screen and modal disagree.
  if (live?.uncompensatedByContract) {
    const byContract = live.uncompensatedByContract;
    candidates = candidates.map((candidate) => ({ ...candidate, uncompensatedSharePercent: byContract.get(candidateContractKey(candidate)) ?? null }));
  }

  const heldLegs: HeldLegScore[] = scoreHeldLegs(inputs.openShortLegs, {
    spotPrice,
    riskFreeRate,
    forecast: inputs.forecast,
    slices,
    quotes,
    ivShiftByExpiry: new Map([...ivShifts].map(([expiry, entry]) => [expiry, entry.shift])),
  });
  const rolls = buildRollCandidates(heldLegs, candidates);

  return {
    ...withCaveats(null),
    candidates,
    best: pickBestCandidate(candidates),
    gradeCounts: countGrades(candidates),
    heldLegs,
    rolls,
    bestRoll: pickBestRoll(rolls),
    rollCount: countRollableLegs(rolls),
    ivShiftByExpiry: Object.fromEntries([...ivShifts].map(([expiry, entry]) => [expiry, { shiftVolatilityPoints: entry.shift * 100, quoteCount: entry.quoteCount }])),
    quoteSourceCounts: countQuoteSources(candidates),
  };
}

/** Synchronous Monte Carlo for every candidate (REST first paint and tests); the live layer runs the same thing in a worker. */
export function computeUncompensatedByContract(candidates: SignalCandidate[], spotPrice: number, slices: SignalSurfaceSlice[], pathCount = liveUncompensatedSharePathCount): Map<string, number | null> {
  const attached = attachUncompensatedShare(candidates, { spotPrice, slices }, { pathCount });
  return new Map(attached.map((candidate) => [candidateContractKey(candidate), candidate.uncompensatedSharePercent]));
}

export function shouldRefreshUncompensatedShare(lastSimulatedSpot: number | null, spotPrice: number): boolean {
  if (lastSimulatedSpot === null || !(lastSimulatedSpot > 0)) return true;
  const floatingPointSlack = 1e-12; // so an exact 0.5% move (100 -> 100.5) counts despite binary rounding
  return Math.abs(spotPrice / lastSimulatedSpot - 1) >= uncompensatedShareRefreshSpotMoveFraction - floatingPointSlack;
}

export function candidateContractRef(candidate: SignalCandidate): ContractRef {
  return { expiry: candidate.expiry, strike: candidate.strike, right: candidate.strategyKey === "covered_call" ? "C" : "P" };
}

/**
 * The contracts the modal subscribes to live quotes for: every open short leg's contract first (Roll Signals,
 * one line per leg), then the selected expiry's candidates, capped in total at liveQuoteMaxContracts
 * (Marcelo 2026-09-24 — every other expiry rides on the Day Signals quotes).
 */
export function selectLiveQuoteContracts(candidates: SignalCandidate[], selectedExpiry: string | null, heldLegs: ContractRef[] = [], options = { maxContracts: liveQuoteMaxContracts }): ContractRef[] {
  const selected: ContractRef[] = [];
  const seen = new Set<string>();
  for (const leg of heldLegs) {
    const key = heldLegContractKey(leg);
    if (seen.has(key) || selected.length >= options.maxContracts) continue;
    seen.add(key);
    selected.push({ expiry: leg.expiry, strike: leg.strike, right: leg.right });
  }
  if (!selectedExpiry) return selected;
  for (const candidate of candidates) {
    if (candidate.expiry !== selectedExpiry || selected.length >= options.maxContracts) continue;
    const ref = candidateContractRef(candidate);
    const key = contractKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(ref);
  }
  return selected;
}

export function toScreenRow(signals: TickerSignals): SignalsScreenRow {
  const { candidates: _candidates, rolls: _rolls, ...row } = signals;
  return row;
}
