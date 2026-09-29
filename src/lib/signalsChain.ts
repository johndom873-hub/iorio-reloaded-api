import { calendarDaysUntilExpiry, captureMaximumDaysToExpiry, captureMinimumDaysToExpiry } from "./optionChainCaptureWindow.js";
import { formatShortDate } from "./formatShortDate.js";
import type { SignalCandidate, SignalContractExclusion, SignalGrade, SignalQuote, SignalQuoteSource, SignalStrategyKey } from "./signalCandidates.js";
import { candidateContractKey, computeUncompensatedByContract, contractKey, mergeLiveQuotes, scoreTicker, type ContractRef, type LiveScoringOverrides } from "./signalsLiveScoring.js";
import type { SignalSettings } from "./signalSettingsStore.js";
import type { AccountContext, SignalsPriceSource, SignalsUnscoredReason, TickerSignals, TickerSignalsInputs } from "./signalsTypes.js";

// The Signals ticker modal's full option chain (mockup approved 2026-09-29):
// every listed strike of an expiry, calls and puts, each cell a Signals
// candidate, a quoted contract Signals excluded (with the reason), or a
// contract the capture never quoted. Plus scoring ONE arbitrary contract the
// way a candidate is scored, with the Signals tab filters lifted. Both run
// the unchanged scoreTicker; nothing here computes a score of its own.

export type SignalsChainCellState = "candidate" | "filtered" | "not_captured";

export interface SignalsChainCell {
  state: SignalsChainCellState;
  bid: number | null;
  ask: number | null;
  /** Surface delta when scoring got that far, else IBKR's delta from the capture; null when not captured. */
  delta: number | null;
  quoteSource: SignalQuoteSource | null;
  quotedAt: string | null;
  /** Candidates only. */
  grade: SignalGrade | null;
  netEdge: number | null;
  /** Filtered only: why Signals left it out, in plain words. */
  reason: string | null;
}

export interface SignalsChainStrikeRow {
  strike: number;
  call: SignalsChainCell;
  put: SignalsChainCell;
}

export interface SignalsChainExpiry {
  expiry: string; // YYYY-MM-DD
  dte: number;
  hasCandidate: boolean;
  /** Today's surface has a usable ('ok') slice for this expiry, so its contracts can get a Signals score. */
  hasFittedSurface: boolean;
}

export interface SignalsChain {
  symbol: string;
  /** On the shortlist or holding an open short leg; outside it every cell is not_captured unless a snapshot exists anyway. */
  inSignalsUniverse: boolean;
  snapshotDateIso: string | null;
  spotPrice: number | null;
  /** Set when the ticker could not be scored at all (then no cell is a candidate). */
  unscoredReason: SignalsUnscoredReason | null;
  expiries: SignalsChainExpiry[];
  /** The expiry `strikes` belongs to; null when the ticker has no listed expiry stored. */
  selectedExpiry: string | null;
  strikes: SignalsChainStrikeRow[];
}

const unscoredTickerReasons: Record<SignalsUnscoredReason, string> = {
  no_snapshot: "No option chain capture for this ticker yet",
  no_surface_fit: "No volatility surface for this ticker today",
  no_forecast: "No volatility forecast for this ticker",
  suspected_split: "Volatility forecast held back (suspected stock split)",
};

export function describeUnscoredTicker(reason: SignalsUnscoredReason): string {
  return unscoredTickerReasons[reason];
}

/** One excluded contract's reason as the chain shows it. Values are absolute delta and percent yields. */
export function describeContractExclusion(exclusion: SignalContractExclusion): string {
  switch (exclusion.kind) {
    case "no_surface_slice":
      return "No volatility surface for this expiry today";
    case "surface_fit_rejected":
      return `This expiry's volatility surface fit was rejected (${exclusion.sliceStatus.replaceAll("_", " ")})`;
    case "expiring_today":
      return "Expires today — Signals does not score same-day expiries";
    case "in_the_money":
      return "In the money — Signals only sells out-of-the-money contracts";
    case "no_two_sided_quote":
      return "No two-sided quote";
    case "spans_earnings":
      return exclusion.earningsDateIso ? `Expiry spans earnings on ${formatShortDate(exclusion.earningsDateIso)}` : "Expiry spans an earnings date";
    case "no_surface_volatility":
      return "The volatility surface gives no volatility at this strike";
    case "above_max_delta":
      return `Δ ${Math.abs(exclusion.delta).toFixed(2)} is over your max Δ ${exclusion.maxNetDelta.toFixed(2)}`;
    case "no_friction":
      return "Friction cost could not be computed for this quote";
    case "no_forecast":
      return "No volatility forecast for this ticker";
    case "below_min_yield":
      return `Yield ${exclusion.annualizedYieldPct.toFixed(1)}%/yr is under your min ${exclusion.minAnnualizedYieldPct}%/yr`;
  }
}

/** The contract's delta when the builder computed one before excluding it. */
function exclusionDelta(exclusion: SignalContractExclusion | undefined): number | null {
  return exclusion && "delta" in exclusion ? exclusion.delta : null;
}

/** One scoreTicker run that also reports the merged quotes and every excluded contract, keyed by contractKey. */
export function scoreTickerWithExclusions(
  inputs: TickerSignalsInputs,
  account: AccountContext,
  settings: SignalSettings,
  live?: LiveScoringOverrides,
): { scored: TickerSignals; scoringQuotes: SignalQuote[]; exclusions: Map<string, SignalContractExclusion> } {
  // A ticker that stops before candidate building (no snapshot / fit / forecast) still shows its stored quotes, day quotes first.
  let scoringQuotes: SignalQuote[] = mergeLiveQuotes(inputs.quotes, inputs.dayQuotes, "day");
  const exclusions = new Map<string, SignalContractExclusion>();
  const scored = scoreTicker(inputs, account, settings, live, {
    onScoringQuotes: (quotes) => {
      scoringQuotes = quotes;
    },
    onContractExcluded: (quote, exclusion) => exclusions.set(contractKey(quote), exclusion),
  });
  return { scored, scoringQuotes, exclusions };
}

export function yyyymmddToIso(expiry: string): string {
  return `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;
}

export interface AssembleSignalsChainInput {
  symbol: string;
  inSignalsUniverse: boolean;
  /** Stored strike grid per expiry, keyed YYYYMMDD as option_chain_expiry_strikes stores it. */
  strikesByExpiry: Map<string, number[]>;
  todayEasternIso: string;
  /** YYYY-MM-DD; null picks the first expiry with a candidate, else the nearest. */
  requestedExpiry: string | null;
  /** Null for a ticker without loaded Signals inputs. */
  scoring: { inputs: TickerSignalsInputs; scored: TickerSignals; scoringQuotes: SignalQuote[]; exclusions: Map<string, SignalContractExclusion> } | null;
  /** IBKR's own delta from the capture, keyed by contractKey (fallback when scoring never computed one). */
  capturedDeltaByContract: Map<string, number>;
}

const notCapturedCell: SignalsChainCell = { state: "not_captured", bid: null, ask: null, delta: null, quoteSource: null, quotedAt: null, grade: null, netEdge: null, reason: null };

/** Pure: the expiry list and the selected expiry's strike rows. */
export function assembleSignalsChain(input: AssembleSignalsChainInput): SignalsChain {
  const { scoring } = input;
  const candidates = scoring?.scored.candidates ?? [];
  const candidatesByKey = new Map(candidates.map((candidate) => [candidateContractKey(candidate), candidate]));
  const quotesByKey = new Map((scoring?.scoringQuotes ?? []).map((quote) => [contractKey(quote), quote]));
  const fittedExpiries = new Set((scoring?.inputs.slices ?? []).filter((slice) => slice.status === "ok" && slice.parameters).map((slice) => slice.expiry));
  const unscoredReason = scoring?.scored.unscoredReason ?? null;

  // Stored grids, plus any quoted strike the grid lacks, inside the capture's own DTE range.
  const strikesByIsoExpiry = new Map<string, Set<number>>();
  for (const [expiry, strikes] of input.strikesByExpiry) strikesByIsoExpiry.set(yyyymmddToIso(expiry), new Set(strikes));
  for (const quote of quotesByKey.values()) {
    const strikes = strikesByIsoExpiry.get(quote.expiry) ?? new Set<number>();
    strikes.add(quote.strike);
    strikesByIsoExpiry.set(quote.expiry, strikes);
  }
  const expiries: SignalsChainExpiry[] = [...strikesByIsoExpiry.keys()]
    .map((expiry) => ({ expiry, dte: calendarDaysUntilExpiry(input.todayEasternIso, expiry.replaceAll("-", "")) }))
    .filter(({ dte }) => dte >= captureMinimumDaysToExpiry && dte <= captureMaximumDaysToExpiry)
    .sort((a, b) => a.expiry.localeCompare(b.expiry))
    .map(({ expiry, dte }) => ({ expiry, dte, hasCandidate: candidates.some((candidate) => candidate.expiry === expiry), hasFittedSurface: fittedExpiries.has(expiry) }));

  const selectedExpiry =
    (input.requestedExpiry && expiries.some((entry) => entry.expiry === input.requestedExpiry) ? input.requestedExpiry : null) ??
    expiries.find((entry) => entry.hasCandidate)?.expiry ??
    expiries[0]?.expiry ??
    null;

  const cellFor = (ref: ContractRef): SignalsChainCell => {
    const key = contractKey(ref);
    const candidate = candidatesByKey.get(key);
    if (candidate) {
      return { state: "candidate", bid: candidate.bid, ask: candidate.ask, delta: candidate.delta, quoteSource: candidate.quoteSource, quotedAt: candidate.quotedAt, grade: candidate.grade, netEdge: candidate.netEdge, reason: null };
    }
    const quote = quotesByKey.get(key);
    if (!quote) return notCapturedCell;
    const exclusion = scoring?.exclusions.get(key);
    const reason = exclusion ? describeContractExclusion(exclusion) : unscoredReason ? describeUnscoredTicker(unscoredReason) : "Not a Signals candidate";
    return {
      state: "filtered",
      bid: quote.bid,
      ask: quote.ask,
      delta: exclusionDelta(exclusion) ?? input.capturedDeltaByContract.get(key) ?? null,
      quoteSource: quote.source ?? "snapshot",
      quotedAt: quote.quotedAt ?? null,
      grade: null,
      netEdge: null,
      reason,
    };
  };

  const strikes: SignalsChainStrikeRow[] = selectedExpiry
    ? [...(strikesByIsoExpiry.get(selectedExpiry) ?? [])]
        .sort((a, b) => a - b)
        .map((strike) => ({ strike, call: cellFor({ expiry: selectedExpiry, strike, right: "C" }), put: cellFor({ expiry: selectedExpiry, strike, right: "P" }) }))
    : [];

  return {
    symbol: input.symbol,
    inSignalsUniverse: input.inSignalsUniverse,
    snapshotDateIso: scoring?.scored.snapshotDateIso ?? null,
    spotPrice: scoring?.scored.spotPrice ?? null,
    unscoredReason,
    expiries,
    selectedExpiry,
    strikes,
  };
}

// ---- Scoring one arbitrary contract ----

export interface SignalContractContext {
  right: "C" | "P";
  /** Passes today's Signals tab filters too (it is one of the modal's candidates). */
  isCandidate: boolean;
  /** Why it is not a candidate (or not scored); null for a candidate. */
  notCandidateReason: string | null;
  /** The spot the contract was scored at. */
  spotPrice: number | null;
  priceSource: SignalsPriceSource;
}

/** Scored exactly like a candidate: a SignalCandidate the order form takes unchanged. */
export interface ScoredSignalContract extends SignalCandidate, SignalContractContext {
  scored: true;
}

/** No Signals score (no surface for the expiry, in the money, spans earnings, no two-sided quote, ...): the quote alone. */
export interface UnscoredSignalContract extends SignalContractContext {
  scored: false;
  strategyKey: SignalStrategyKey;
  expiry: string;
  strike: number;
  dte: number;
  bid: number | null;
  ask: number | null;
  /** IBKR's own delta (live, else the capture's); null when neither has one. */
  delta: number | null;
  quoteSource: SignalQuoteSource | null;
  quotedAt: string | null;
}

export type SignalContractScore = ScoredSignalContract | UnscoredSignalContract;

export interface SignalContractLiveQuote {
  bid: number | null;
  ask: number | null;
  delta: number | null;
  /** When the reading was taken (ISO). */
  quotedAt: string;
}

export interface ScoreSignalContractInput {
  inputs: TickerSignalsInputs;
  account: AccountContext;
  settings: SignalSettings;
  contract: ContractRef;
  /** One pooled live reading of the contract; null when lines are off, the market is closed or none arrived. */
  liveQuote: SignalContractLiveQuote | null;
  /** The modal's live spot; null scores at the snapshot's spot. */
  liveSpot: { spotPrice: number; priceSource: SignalsPriceSource } | null;
  capturedDelta: number | null;
  /** Monte Carlo path count override (tests). */
  uncompensatedSharePathCount?: number;
}

const filtersLifted = { maxNetDelta: Number.POSITIVE_INFINITY, minAnnualizedYieldPct: Number.NEGATIVE_INFINITY };

/**
 * Pure (apart from the Monte Carlo): scores one contract through scoreTicker, first with the real Signals tab settings (a hit is a
 * candidate, identical to the modal's), then with max delta / min yield lifted. Anything the builder still excludes comes back
 * unscored with its reason. A contract missing from the capture gets an empty snapshot row so the day/live merge can fill it.
 */
export function scoreSignalContract(input: ScoreSignalContractInput): SignalContractScore {
  const { contract, inputs } = input;
  const key = contractKey(contract);
  const quotes = inputs.quotes.some((quote) => contractKey(quote) === key) ? inputs.quotes : [...inputs.quotes, { ...contract, bid: null, ask: null, source: "snapshot" as const }];
  const withContract: TickerSignalsInputs = { ...inputs, quotes };
  const snapshotSpot = inputs.header?.underlyingPrice ?? null;
  const spotPrice = input.liveSpot?.spotPrice ?? snapshotSpot;
  const priceSource: SignalsPriceSource = input.liveSpot?.priceSource ?? "snapshot";
  const liveQuotes = input.liveQuote ? [{ ...contract, bid: input.liveQuote.bid, ask: input.liveQuote.ask, quotedAt: input.liveQuote.quotedAt }] : [];
  const live: LiveScoringOverrides | undefined = spotPrice === null ? undefined : { spotPrice, priceSource, liveQuotes };

  const withSettings = scoreTickerWithExclusions(withContract, input.account, input.settings, live);
  const matching = (scored: TickerSignals) => scored.candidates.find((candidate) => candidateContractKey(candidate) === key) ?? null;
  const context = (isCandidate: boolean, notCandidateReason: string | null): SignalContractContext => ({ right: contract.right, isCandidate, notCandidateReason, spotPrice, priceSource });
  const withMonteCarlo = (candidate: SignalCandidate): SignalCandidate => {
    if (spotPrice === null) return candidate;
    const byContract = computeUncompensatedByContract([candidate], spotPrice, inputs.slices, input.uncompensatedSharePathCount);
    return { ...candidate, uncompensatedSharePercent: byContract.get(key) ?? null };
  };

  const candidate = matching(withSettings.scored);
  if (candidate) return { ...withMonteCarlo(candidate), ...context(true, null), scored: true };

  const exclusion = withSettings.exclusions.get(key);
  const scoringQuote = withSettings.scoringQuotes.find((quote) => contractKey(quote) === key) ?? null;
  const liveTwoSided = input.liveQuote && input.liveQuote.bid !== null && input.liveQuote.ask !== null ? input.liveQuote : null;
  // Missing from the capture with no day/live quote either: "no two-sided quote" would undersell it.
  const nothingQuoted = !liveTwoSided && inputs.quotes.every((quote) => contractKey(quote) !== key) && (scoringQuote?.bid ?? null) === null && (scoringQuote?.ask ?? null) === null;
  const reason = nothingQuoted && (!exclusion || exclusion.kind === "no_two_sided_quote")
    ? "Not in today's capture and no live quote (market closed or live data off)"
    : exclusion
      ? describeContractExclusion(exclusion)
    : withSettings.scored.unscoredReason
      ? describeUnscoredTicker(withSettings.scored.unscoredReason)
      : "Not a Signals candidate";

  const lifted = scoreTickerWithExclusions(withContract, input.account, { ...input.settings, ...filtersLifted }, live);
  const liftedCandidate = matching(lifted.scored);
  if (liftedCandidate) return { ...withMonteCarlo(liftedCandidate), ...context(false, reason), scored: true };

  const bid = liveTwoSided?.bid ?? scoringQuote?.bid ?? null;
  const ask = liveTwoSided?.ask ?? scoringQuote?.ask ?? null;
  const quoteSource: SignalQuoteSource | null = liveTwoSided ? "live" : bid !== null || ask !== null ? (scoringQuote?.source ?? "snapshot") : null;
  return {
    ...context(false, `${reason} — shown without a Signals score`),
    scored: false,
    strategyKey: contract.right === "C" ? "covered_call" : "cash_secured_put",
    expiry: contract.expiry,
    strike: contract.strike,
    dte: calendarDaysUntilExpiry(inputs.todayEasternIso, contract.expiry.replaceAll("-", "")),
    bid,
    ask,
    delta: input.liveQuote?.delta ?? input.capturedDelta,
    quoteSource,
    quotedAt: quoteSource === "live" ? liveTwoSided!.quotedAt : quoteSource === null ? null : (scoringQuote?.quotedAt ?? null),
  };
}
