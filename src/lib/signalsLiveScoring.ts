import { sviTotalVariance, yearsBetweenIsoDates } from "./impliedVolatilitySurface.js";
import { easternInstant, easternIsoDate, easternMinutesOfDay } from "./easternIsoDate.js";
import type { TradingSession } from "./marketSessionStatus.js";
import { varianceSessionsToExpiry } from "./varianceClock.js";
import { volatilityModelTables } from "./volatilityModelTables.generated.js";
import type { VolatilityModelTables } from "./volatilityModelTables.js";
import { attachUncompensatedShare, buildSignalCandidates, type CandidateModelContext, computeExpiryIvShifts, emptyCandidateExclusionTally, gradeSignalCandidates, liveUncompensatedSharePathCount, pickBestCandidate, uncompensatedShareRefreshSpotMoveFraction, type CandidateExclusionTally, type SignalCandidate, type SignalCandidatesInput, type SignalQuote, type SignalSurfaceSlice } from "./signalCandidates.js";
import { buildRollCandidates, pickBestRoll, scoreHeldLegs, type HeldLegScore, type RollSignalCandidate } from "./rollSignalCandidates.js";
import { buildTickerCaveats } from "./signalsRoadmap.js";
import type { TradingSettings } from "./tradingSettingsStore.js";
import { skewMinimumDaysToExpiry, skewTargetDaysToExpiry } from "./tiltMeasures.js";
import { minimumBarsForAnyForecast, tradingSessionsByExpiry } from "./volatilityEdge.js";
import type { AccountContext, DayQuotesAsOf, GradeCounts, PreviousClose, QuoteSourceCounts, SignalsNoCandidatesReason, SignalsPriceSource, SignalsScreenRow, SignalsUnscoredDetail, TickerSignals, TickerSignalsInputs } from "./signalsTypes.js";

// Pure re-scoring for the Signals live layer (stage 2, decisions with Marcelo 2026-09-22):
// the fitted surface stays the 10:00 snapshot and follows the live spot by sticky
// moneyness (every expiry's forward scales with spot); live bid/ask replace the
// snapshot's only for the contracts the modal subscribes to (marked quoteSource
// "live"); frames go out at most once a second; account context refreshes every
// 60 s; UncompensatedShare is refreshed separately (worker thread, every 5 s after
// a >= 0.5% spot move) and carried across re-scores by contract key.

export const liveFrameIntervalMs = 1_000;
export const accountRefreshIntervalMs = 60_000;

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
  /** IBKR's own delta, only where the source carries it (the pooled option line does). */
  delta?: number | null;
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

/**
 * Sticky moneyness: the 10:00 surface is re-read at the live spot by moving every expiry's forward in proportion to the underlying
 * price that forward is anchored to (its own `fitUnderlyingPrice`, else the snapshot spot for fits that predate it). At the snapshot
 * spot itself the slices are returned as fitted, quotes and forward being consistent as captured.
 */
export function scaleSlicesToLiveSpot(slices: SignalSurfaceSlice[], snapshotSpot: number, liveSpot: number): SignalSurfaceSlice[] {
  if (!(snapshotSpot > 0) || !(liveSpot > 0) || liveSpot === snapshotSpot) return slices;
  return slices.map((slice) => ({ ...slice, forwardPrice: slice.forwardPrice * (liveSpot / (slice.fitUnderlyingPrice ?? snapshotSpot)) }));
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
 * A wanted contract is not always in the 10:00 snapshot (a held leg outside the strike window, or a contract that
 * only became out-of-the-money after the price moved), and mergeLiveQuotes only replaces snapshot rows. This appends
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

/** Held legs with at least one roll the valuation model grades above Avoid (what Pluto could act on): the screen badge's count. */
export function countRollableLegs(rolls: RollSignalCandidate[]): number {
  return new Set(rolls.filter((roll) => roll.model !== null && roll.model.grade !== "avoid").map((roll) => roll.legId)).size;
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
 * Re-times a surface fitted on an earlier day to today (2026-09-24; on the variance clock since 2026-10-10, model review
 * P2): after a missed capture the screen scored yesterday's slices with yesterday's time to expiry. Expiries already past
 * are dropped; yearsToExpiry is recomputed from today's Eastern date (calendar days, for discounting and the old Edge);
 * the SVI total variance (a and b are linear in it) is scaled by the variance the market will still price today at the
 * capture's time of day over what it priced at the capture: τ(today, same time → expiry) ÷ τ(capture → expiry). The
 * weekend therefore removes about one session of variance, as the market does, not three calendar days. A surface
 * fitted today is returned as fitted. `sessions` must cover the capture's date through the furthest expiry.
 */
export function rebaseSlicesToToday(slices: SignalSurfaceSlice[], todayEasternIso: string, fitCapturedAtMs: number, sessions: readonly TradingSession[]): SignalSurfaceSlice[] {
  if (easternIsoDate(new Date(fitCapturedAtMs)) >= todayEasternIso) return slices;
  const todayAtFitTimeMs = sameTimeToday(fitCapturedAtMs, todayEasternIso);
  const rebased: SignalSurfaceSlice[] = [];
  for (const slice of slices) {
    const yearsToExpiry = yearsBetweenIsoDates(todayEasternIso, slice.expiry);
    if (!(yearsToExpiry > 0)) continue;
    const varianceAtFit = varianceSessionsToExpiry(fitCapturedAtMs, slice.expiry, sessions);
    const varianceToday = varianceSessionsToExpiry(todayAtFitTimeMs, slice.expiry, sessions);
    if (!(varianceAtFit > 0) || !(varianceToday > 0)) continue;
    const scale = varianceToday / varianceAtFit;
    rebased.push({
      ...slice,
      yearsToExpiry,
      parameters: slice.parameters ? { ...slice.parameters, a: slice.parameters.a * scale, b: slice.parameters.b * scale } : null,
    });
  }
  return rebased;
}

/**
 * At-the-money IV of the same slice computeAtmImpliedVolatility reads, on the forecast's clock: √(252 × total variance ÷ τ)
 * with τ from `atMs` (the instant the slices describe) to that expiry's close.
 */
export function computeAtmImpliedVolatilityPerSession(slices: SignalSurfaceSlice[], atMs: number, sessions: readonly TradingSession[]): number | null {
  const eligible = slices.filter((slice) => slice.status === "ok" && slice.parameters && slice.yearsToExpiry * 365 >= skewMinimumDaysToExpiry);
  if (eligible.length === 0) return null;
  const nearest = eligible.reduce((best, slice) => (Math.abs(slice.yearsToExpiry * 365 - skewTargetDaysToExpiry) < Math.abs(best.yearsToExpiry * 365 - skewTargetDaysToExpiry) ? slice : best));
  const totalVariance = sviTotalVariance(nearest.parameters!, 0);
  const varianceSessions = varianceSessionsToExpiry(atMs, nearest.expiry, sessions);
  return totalVariance > 0 && varianceSessions > 0 ? Math.sqrt((252 * totalVariance) / varianceSessions) : null;
}

/** Read-only hooks into one scoreTicker run (the Signals chain grid and the any-contract scorer); never change the result. */
export interface ScoreTickerObserver {
  /** The merged quotes candidates were built from (snapshot, then day, then live), when the ticker got that far. */
  onScoringQuotes?(quotes: SignalQuote[]): void;
  onContractExcluded?: SignalCandidatesInput["onContractExcluded"];
}

/** For replaying a past day (the backtest): the model tables of that time and the scoring instant. Live leaves both out. */
export interface ScoreTickerHistoryOptions {
  /** The valuation model's tables; the generated module's when omitted. */
  modelTables?: VolatilityModelTables;
  /** The scoring instant; the clock when omitted. */
  scoredAtMs?: number;
}

/** Scores one ticker from its loaded inputs; `live` re-reads the snapshot at the live spot and merges live quotes. */
export function scoreTicker(inputs: TickerSignalsInputs, account: AccountContext, settings: TradingSettings, live?: LiveScoringOverrides, observer?: ScoreTickerObserver, history: ScoreTickerHistoryOptions = {}): TickerSignals {
  const { header } = inputs;
  const spotPrice = live?.spotPrice ?? header?.underlyingPrice ?? null;
  const spreadShareCharged = settings.spreadCostChargedPct / 100;
  const base: Omit<TickerSignals, "unscoredReason" | "unscoredDetail"> = {
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
    heldLegs: scoreHeldLegs(inputs.openShortLegs, { spotPrice: spotPrice ?? 0, riskFreeRate: 0, forecast: null, tradingSessionsByExpiry: new Map(), slices: [], quotes: [], spreadShareCharged }),
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
    atmImpliedVolatility: header ? computeAtmImpliedVolatility(rebaseSlicesToToday(inputs.slices, inputs.todayEasternIso, Date.parse(header.capturedAt), inputs.tradingSessions)) : null,
    atmImpliedVolatilityPerSession: header ? computeAtmImpliedVolatilityPerSession(rebaseSlicesToToday(inputs.slices, inputs.todayEasternIso, Date.parse(header.capturedAt), inputs.tradingSessions), sameTimeToday(Date.parse(header.capturedAt), inputs.todayEasternIso), inputs.tradingSessions) : null,
    forecast: inputs.forecast,
    modelForecast: inputs.modelForecast,
    dailyBarCount: inputs.dailyBarCount,
    dividendCadenceUnknown: inputs.dividendCadenceUnknown,
    caveats: [],
    freeShares: inputs.freeShares,
    freeCash: account.freeCash,
    dayQuotesAsOf: summarizeDayQuotes(inputs.dayQuotes),
    spreadShareCharged,
    ivShiftByExpiry: {},
    quoteSourceCounts: { live: 0, day: 0, snapshot: 0 },
    noCandidatesReason: null,
  };
  const withCaveats = (unscoredReason: TickerSignals["unscoredReason"], unscoredDetail: SignalsUnscoredDetail | null = null): TickerSignals => ({
    ...base,
    unscoredReason,
    unscoredDetail,
    caveats: buildTickerCaveats({ unscoredReason, dailyBarCount: inputs.dailyBarCount, dividendCadenceUnknown: inputs.dividendCadenceUnknown, snapshotDateIso: base.snapshotDateIso }, inputs.todayEasternIso),
  });

  if (!header) return withCaveats("no_snapshot");
  // Saved but not yet analysed: pending, not a problem (the fit finishes within seconds of the capture).
  if (header.fitCompletedAt === null) return withCaveats("analysing", { kind: "analysing", snapshotCapturedAt: header.capturedAt });
  if (base.fittedSliceCount === 0 || header.underlyingPrice === null || header.riskFreeRatePercent === null) return withCaveats("no_surface_fit", describeFitIssue(inputs));
  if (!inputs.forecast) return withCaveats("no_forecast", { kind: "forecast", dailyBarCount: inputs.dailyBarCount, barsNeeded: minimumBarsForAnyForecast });
  if (spotPrice === null) return withCaveats("no_snapshot");

  const capturedAtMs = Date.parse(header.capturedAt);
  const todaySlices = rebaseSlicesToToday(inputs.slices, inputs.todayEasternIso, capturedAtMs, inputs.tradingSessions);
  const slices = live ? scaleSlicesToLiveSpot(todaySlices, header.underlyingPrice, live.spotPrice) : todaySlices;
  const fittedForwardByExpiry = new Map(todaySlices.map((slice) => [slice.expiry, slice.forwardPrice]));
  const snapshotSpot = header.underlyingPrice;
  const scoredAtMs = history.scoredAtMs ?? Date.now();
  // The valuation model (model review P2–P5): each quote valued at its own instant, forward and spot (signalCandidates.ts).
  const model: CandidateModelContext | null = inputs.modelForecast
    ? {
        tables: history.modelTables ?? volatilityModelTables,
        forecast: inputs.modelForecast,
        group: inputs.valuationGroup,
        varianceSessionsAt: (atMs, expiryIso) => varianceSessionsToExpiry(atMs, expiryIso, inputs.tradingSessions),
        // A snapshot quote's instant is the capture, on any later day too: its price is valued over the variance left then.
        quoteInstantMs: (quote) => (quote.quotedAt ? Date.parse(quote.quotedAt) : quote.source === "live" ? scoredAtMs : capturedAtMs),
        forwardForQuote: (slice, quote) => (quote.source === "live" || quote.source === "day" ? slice.forwardPrice : fittedForwardByExpiry.get(slice.expiry) ?? slice.forwardPrice),
        spotForQuote: (quote) => (quote.source === "live" || quote.source === "day" ? spotPrice : snapshotSpot),
      }
    : null;
  // Precedence per contract: pooled live (modal / screen best line) > day (refresh loop) > 10:00 snapshot.
  const withDayQuotes = mergeLiveQuotes(inputs.quotes, inputs.dayQuotes, "day");
  const mergedQuotes = live?.liveQuotes ? mergeLiveQuotes(withDayQuotes, live.liveQuotes, "live") : withDayQuotes;
  const heldLegRefs: ContractRef[] = inputs.openShortLegs.map((leg) => ({ expiry: leg.expiry, strike: leg.strike, right: leg.right }));
  // Contracts the loop or the modal quoted that the 10:00 snapshot never stored (the price moved past the capture window) are scored too.
  const quotes = appendMissingContractQuotes(mergedQuotes, [...heldLegRefs, ...inputs.dayQuotes, ...(live?.liveQuotes ?? [])], inputs.dayQuotes, live?.liveQuotes ?? []);
  const riskFreeRate = header.riskFreeRatePercent / 100;
  const ivShifts = computeExpiryIvShifts(slices, quotes, riskFreeRate);
  const sessionsByExpiry = tradingSessionsByExpiry(slices.map((slice) => slice.expiry), inputs.openSessionDatesIso, inputs.todayEasternIso);
  observer?.onScoringQuotes?.(quotes);

  const exclusionTally = emptyCandidateExclusionTally();
  let candidates = gradeSignalCandidates(
    buildSignalCandidates({
      exclusionTally,
      spotPrice,
      riskFreeRate,
      forecast: inputs.forecast,
      tradingSessionsByExpiry: sessionsByExpiry,
      slices,
      quotes,
      earningsDatesIso: inputs.earningsDatesIso,
      earningsCalendarResolved: inputs.earningsCalendarResolved,
      macroEvents: inputs.macroEvents.map((event) => ({ dateIso: event.dateIso, eventAtMs: Date.parse(event.eventAtIso) })),
      todayEasternIso: inputs.todayEasternIso,
      // The clock, not the snapshot: an event earlier today is over, a release later today is still ahead.
      scoredAtMs,
      freeShares: inputs.freeShares,
      freeCash: account.freeCash,
      deltaTargetMin: settings.deltaTargetMin,
      deltaTargetMax: settings.deltaTargetMax,
      minAnnualizedYieldPct: settings.minAnnualizedYieldPct,
      ivShiftByExpiry: new Map([...ivShifts].map(([expiry, entry]) => [expiry, entry.shift])),
      commissionEstimator: settings.commissionEstimator,
      spreadShareCharged,
      onContractExcluded: observer?.onContractExcluded,
      model,
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
    tradingSessionsByExpiry: sessionsByExpiry,
    slices,
    quotes,
    ivShiftByExpiry: new Map([...ivShifts].map(([expiry, entry]) => [expiry, entry.shift])),
    commissionEstimator: settings.commissionEstimator,
    spreadShareCharged,
    model,
  });
  const rolls = buildRollCandidates(heldLegs, candidates, settings.commissionEstimator);

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
    noCandidatesReason: candidates.length > 0 ? null : describeNoCandidates(exclusionTally, inputs.earningsDatesIso, inputs.todayEasternIso, settings),
  };
}

/** Pure: what the fit left behind for a snapshot with no usable surface: slice counts by status, plus why the fit produced nothing when it did not run to the end. */
export function describeFitIssue(inputs: Pick<TickerSignalsInputs, "slices" | "header">): SignalsUnscoredDetail {
  const sliceStatusCounts: Record<string, number> = {};
  for (const slice of inputs.slices) sliceStatusCounts[slice.status] = (sliceStatusCounts[slice.status] ?? 0) + 1;
  const header = inputs.header;
  // A header gap names the cause when the fit left no issue of its own.
  const headerIssue = header ? (header.underlyingPrice === null ? "no_spot_price" : header.riskFreeRatePercent === null ? "no_risk_free_rate" : null) : null;
  return { kind: "fit", sliceStatusCounts, expiryCount: inputs.slices.length, fitIssue: header?.fitIssue ?? headerIssue };
}

/** Pure: turns the builder's exclusion tally into the reason a scored ticker shows no candidates. */
export function describeNoCandidates(
  tally: CandidateExclusionTally,
  earningsDatesIso: string[],
  todayEasternIso: string,
  settings: { minAnnualizedYieldPct: number; deltaTargetMin: number; deltaTargetMax: number },
): SignalsNoCandidatesReason {
  const filtered = tally.belowMinDeltaCount + tally.aboveMaxDeltaCount + tally.belowMinYieldCount > 0;
  // From today on, as expirySpansEarnings counts it.
  const nextEarnings = [...earningsDatesIso].sort().find((dateIso) => dateIso >= todayEasternIso) ?? null;
  return {
    kind: filtered ? "filtered" : "nothing_scorable",
    surfaceFitRejectedExpiries: [...tally.surfaceFitRejectedExpiries].sort(),
    spansEarningsExpiries: [...tally.spansEarningsExpiries].sort(),
    earningsDateIso: tally.spansEarningsExpiries.size > 0 ? nextEarnings : null,
    belowMinDeltaCount: tally.belowMinDeltaCount,
    aboveMaxDeltaCount: tally.aboveMaxDeltaCount,
    belowMinYieldCount: tally.belowMinYieldCount,
    bestAnnualizedYieldPct: tally.bestAnnualizedYieldPct,
    minAnnualizedYieldPct: settings.minAnnualizedYieldPct,
    deltaTargetMin: settings.deltaTargetMin,
    deltaTargetMax: settings.deltaTargetMax,
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
 * The instant on today's date at the capture's Eastern time of day: the instant a surface rolled to today describes
 * (rebaseSlicesToToday). The capture itself on the capture's own day.
 */
export function sameTimeToday(capturedAtMs: number, todayEasternIso: string): number {
  if (easternIsoDate(new Date(capturedAtMs)) >= todayEasternIso) return capturedAtMs;
  const minutes = easternMinutesOfDay(new Date(capturedAtMs));
  return easternInstant(todayEasternIso, Math.floor(minutes / 60), minutes % 60).getTime();
}

export function toScreenRow(signals: TickerSignals): SignalsScreenRow {
  const { candidates: _candidates, rolls: _rolls, ...row } = signals;
  return row;
}
