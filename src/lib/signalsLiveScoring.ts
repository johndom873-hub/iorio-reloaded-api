import { sviTotalVariance } from "./impliedVolatilitySurface.js";
import { attachUncompensatedShare, buildSignalCandidates, gradeSignalCandidates, liveUncompensatedSharePathCount, pickBestCandidate, uncompensatedShareRefreshSpotMoveFraction, type SignalCandidate, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { buildTickerCaveats } from "./signalsRoadmap.js";
import { skewMinimumDaysToExpiry, skewTargetDaysToExpiry } from "./tiltMeasures.js";
import type { AccountContext, GradeCounts, PreviousClose, SignalsPriceSource, SignalsScreenRow, TickerSignals, TickerSignalsInputs } from "./signalsTypes.js";

// Pure re-scoring for the Signals live layer (stage 2, decisions with Marcelo 2026-09-22):
// the fitted surface stays the 10:00 snapshot and follows the live spot by sticky
// moneyness (every expiry's forward scales with spot); live bid/ask replace the
// snapshot's only for the contracts the modal subscribes to (marked quoteSource
// "live"); frames go out at most once a second; account context refreshes every
// 60 s; UncompensatedShare is refreshed separately (worker thread, every 5 s after
// a >= 0.5% spot move) and carried across re-scores by contract key.

export const liveFrameIntervalMs = 1_000;
export const accountRefreshIntervalMs = 60_000;
export const liveQuoteTopCandidates = 20;
export const liveQuoteMaxContracts = 40;

export interface ContractRef {
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
}

export interface LiveOptionQuote extends ContractRef {
  bid: number | null;
  ask: number | null;
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

/** Live two-sided quotes replace the snapshot's bid/ask; a live quote missing a side leaves the snapshot quote in place. */
export function mergeLiveQuotes(snapshotQuotes: SignalQuote[], liveQuotes: LiveOptionQuote[]): SignalQuote[] {
  if (liveQuotes.length === 0) return snapshotQuotes;
  const liveByKey = new Map(liveQuotes.map((quote) => [contractKey(quote), quote]));
  return snapshotQuotes.map((quote) => {
    const live = liveByKey.get(contractKey(quote));
    if (!live || live.bid === null || live.ask === null) return quote;
    return { ...quote, bid: live.bid, ask: live.ask, source: "live" };
  });
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

/** Scores one ticker from its loaded inputs; `live` re-reads the snapshot at the live spot and merges live quotes. */
export function scoreTicker(inputs: TickerSignalsInputs, account: AccountContext, live?: LiveScoringOverrides): TickerSignals {
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
    fittedSliceCount: inputs.slices.filter((slice) => slice.status === "ok").length,
    totalSliceCount: inputs.slices.length,
    momentum: inputs.momentum,
    skew: inputs.skew,
    elevatedVolatility: inputs.elevatedVolatility,
    nextEarningsDateIso: inputs.nextEarningsDateIso,
    atmImpliedVolatility: computeAtmImpliedVolatility(inputs.slices),
    forecast: inputs.forecast,
    dailyBarCount: inputs.dailyBarCount,
    dividendCadenceUnknown: inputs.dividendCadenceUnknown,
    caveats: [],
    freeShares: inputs.freeShares,
    freeCash: account.freeCash,
  };
  const withCaveats = (unscoredReason: TickerSignals["unscoredReason"]): TickerSignals => ({
    ...base,
    unscoredReason,
    caveats: buildTickerCaveats({ unscoredReason, suspectedSplitDateIso: inputs.suspectedSplitDateIso, dailyBarCount: inputs.dailyBarCount, dividendCadenceUnknown: inputs.dividendCadenceUnknown }, inputs.todayEasternIso),
  });

  if (!header) return withCaveats("no_snapshot");
  if (base.fittedSliceCount === 0 || header.underlyingPrice === null || header.riskFreeRatePercent === null) return withCaveats("no_surface_fit");
  if (!inputs.forecast) return withCaveats(inputs.suspectedSplitDateIso !== null ? "suspected_split" : "no_forecast");
  if (spotPrice === null) return withCaveats("no_snapshot");

  const slices = live ? scaleSlicesToLiveSpot(inputs.slices, header.underlyingPrice, live.spotPrice) : inputs.slices;
  const quotes = live?.liveQuotes ? mergeLiveQuotes(inputs.quotes, live.liveQuotes) : inputs.quotes;

  let candidates = gradeSignalCandidates(
    buildSignalCandidates({
      spotPrice,
      riskFreeRate: header.riskFreeRatePercent / 100,
      forecast: inputs.forecast,
      slices,
      quotes,
      earningsDatesIso: inputs.earningsDatesIso,
      earningsCalendarResolved: inputs.earningsCalendarResolved,
      snapshotDateIso: header.tradingDateIso,
      freeShares: inputs.freeShares,
      freeCash: account.freeCash,
    }),
  );
  if (live?.uncompensatedByContract) {
    const byContract = live.uncompensatedByContract;
    candidates = candidates.map((candidate) => ({ ...candidate, uncompensatedSharePercent: byContract.get(candidateContractKey(candidate)) ?? null }));
  }

  return { ...withCaveats(null), candidates, best: pickBestCandidate(candidates), gradeCounts: countGrades(candidates) };
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

/**
 * The contracts the modal subscribes to live quotes for: every OTM candidate of the selected
 * expiry, then the best-ranked candidates from other expiries, capped at liveQuoteMaxContracts.
 */
export function selectLiveQuoteContracts(candidates: SignalCandidate[], selectedExpiry: string | null, options = { topCandidates: liveQuoteTopCandidates, maxContracts: liveQuoteMaxContracts }): ContractRef[] {
  const selected: ContractRef[] = [];
  const seen = new Set<string>();
  const add = (candidate: SignalCandidate) => {
    const ref: ContractRef = { expiry: candidate.expiry, strike: candidate.strike, right: candidate.strategyKey === "covered_call" ? "C" : "P" };
    const key = contractKey(ref);
    if (seen.has(key) || selected.length >= options.maxContracts) return;
    seen.add(key);
    selected.push(ref);
  };

  if (selectedExpiry) {
    for (const candidate of candidates) if (candidate.expiry === selectedExpiry) add(candidate);
  }
  const ranked = [...candidates].sort((a, b) => b.edgeDollars - a.edgeDollars || b.netEdge - a.netEdge);
  for (const candidate of ranked.slice(0, options.topCandidates)) add(candidate);
  return selected;
}

export function toScreenRow(signals: TickerSignals): SignalsScreenRow {
  const { candidates: _candidates, ...row } = signals;
  return row;
}
