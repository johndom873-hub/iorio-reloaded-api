import type { SignalCandidate, SignalGrade, SignalQuote, SignalQuoteSource, SignalSurfaceSlice } from "./signalCandidates.js";
import type { LiveOptionQuote } from "./signalsLiveScoring.js";
import type { TickerCaveat } from "./signalsRoadmap.js";
import type { ElevatedVolatilityFlag, SkewMeasure } from "./tiltMeasures.js";
import type { RealizedVolatilityForecast } from "./volatilityEdge.js";

export type SignalsUnscoredReason = "no_snapshot" | "no_surface_fit" | "no_forecast" | "suspected_split";
export type SignalsPriceSource = "live" | "frozen" | "snapshot";

export interface SnapshotHeader {
  snapshotId: string;
  tradingDateIso: string;
  capturedAt: string;
  underlyingPrice: number | null;
  riskFreeRatePercent: number | null;
}

export interface PreviousClose {
  close: number;
  dateIso: string;
}

/** Everything the DB knows about one ticker that scoring needs; loaded once, re-scored many times (live layer). */
export interface TickerSignalsInputs {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  sector: string | null;
  header: SnapshotHeader | null;
  slices: SignalSurfaceSlice[];
  quotes: SignalQuote[];
  /** The Day Signals loop's latest bid/ask for this ticker's pooled contracts, from the same snapshot date as `header`; empty when none. */
  dayQuotes: LiveOptionQuote[];
  forecast: RealizedVolatilityForecast | null;
  /** Trading date the split guard flagged when it left the ticker without a forecast; null otherwise. */
  suspectedSplitDateIso: string | null;
  earningsDatesIso: string[];
  /** False when the ticker has never resolved to a TradingView symbol -- earningsDatesIso is necessarily
   * empty either way, so this is what actually tells the guard "no earnings scheduled" from "unchecked". */
  earningsCalendarResolved: boolean;
  momentum: number | null;
  elevatedVolatility: ElevatedVolatilityFlag | null;
  skew: SkewMeasure | null;
  nextEarningsDateIso: string | null;
  previousClose: PreviousClose | null;
  freeShares: number;
  /** All stored daily bars (momentum needs 253, the own-history volatility threshold 377). */
  dailyBarCount: number;
  /** True when there is an upcoming ex-dividend but no regular cadence could be inferred to project later ones into the forward. */
  dividendCadenceUnknown: boolean;
  /** Eastern session date the inputs were loaded for; caveat ETAs are projected from it. */
  todayEasternIso: string;
}

export interface AccountContext {
  freeCash: number;
}

export type GradeCounts = Record<SignalGrade, number>;
export type QuoteSourceCounts = Record<SignalQuoteSource, number>;

/** Age range of the day quotes merged into this ticker's scoring (ISO times). */
export interface DayQuotesAsOf {
  oldest: string;
  newest: string;
  count: number;
}

/** Formula 3h per expiry: the parallel IV shift applied (in volatility points) and how many fresh quotes it came from. */
export interface ExpiryIvShiftSummary {
  shiftVolatilityPoints: number;
  quoteCount: number;
}

export interface TickerSignals {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  sector: string | null;
  snapshotDateIso: string | null;
  snapshotCapturedAt: string | null;
  spotPrice: number | null;
  priceSource: SignalsPriceSource;
  previousClose: PreviousClose | null;
  dayChangePercent: number | null;
  candidates: SignalCandidate[];
  best: SignalCandidate | null;
  gradeCounts: GradeCounts;
  fittedSliceCount: number;
  totalSliceCount: number;
  momentum: number | null;
  skew: SkewMeasure | null;
  elevatedVolatility: ElevatedVolatilityFlag | null;
  nextEarningsDateIso: string | null;
  /** At-the-money IV of the fitted slice nearest 30 days (constant across spot moves under sticky moneyness). */
  atmImpliedVolatility: number | null;
  forecast: RealizedVolatilityForecast | null;
  dailyBarCount: number;
  dividendCadenceUnknown: boolean;
  /** Ticker-specific "not accounted for" caveats (no snapshot, short history, dividend payer). */
  caveats: TickerCaveat[];
  /** What "executable" was judged against: uncovered shares of this ticker and free cash in the account. */
  freeShares: number;
  freeCash: number;
  dayQuotesAsOf: DayQuotesAsOf | null;
  ivShiftByExpiry: Record<string, ExpiryIvShiftSummary>;
  quoteSourceCounts: QuoteSourceCounts;
  unscoredReason: SignalsUnscoredReason | null;
}

/** One Signals-screen row: a TickerSignals without the candidate list (the modal fetches that per ticker). */
export type SignalsScreenRow = Omit<TickerSignals, "candidates">;

/** Single-ticker REST payload only: adds the raw fitted-surface slices (SVI params + fit-quality diagnostics)
 * for the volatility-surface modal. Left off SignalsScreenRow/the list endpoint so the whole-screen payload
 * doesn't carry every ticker's per-expiry SVI parameters. */
export interface TickerSignalsDetail extends TickerSignals {
  slices: SignalSurfaceSlice[];
}
