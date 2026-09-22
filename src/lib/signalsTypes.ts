import type { SignalCandidate, SignalGrade, SignalQuote, SignalSurfaceSlice } from "./signalCandidates.js";
import type { TickerCaveat } from "./signalsRoadmap.js";
import type { ElevatedVolatilityFlag, SkewMeasure } from "./tiltMeasures.js";
import type { RealizedVolatilityForecast } from "./volatilityEdge.js";

export type SignalsUnscoredReason = "no_snapshot" | "no_surface_fit" | "no_forecast";
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
  forecast: RealizedVolatilityForecast | null;
  earningsDatesIso: string[];
  momentum: number | null;
  elevatedVolatility: ElevatedVolatilityFlag | null;
  skew: SkewMeasure | null;
  nextEarningsDateIso: string | null;
  previousClose: PreviousClose | null;
  freeShares: number;
  /** All stored daily bars (momentum needs 253, the own-history volatility threshold 377). */
  dailyBarCount: number;
  /** Any ex-dividend event on record: only the next dividend enters the forward, so payers carry a caveat. */
  hasDividendEvents: boolean;
  /** Eastern session date the inputs were loaded for; caveat ETAs are projected from it. */
  todayEasternIso: string;
}

export interface AccountContext {
  freeCash: number;
}

export type GradeCounts = Record<SignalGrade, number>;

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
  hasDividendEvents: boolean;
  /** Ticker-specific "not accounted for" caveats (no snapshot, short history, dividend payer). */
  caveats: TickerCaveat[];
  /** What "executable" was judged against: uncovered shares of this ticker and free cash in the account. */
  freeShares: number;
  freeCash: number;
  unscoredReason: SignalsUnscoredReason | null;
}

/** One Signals-screen row: a TickerSignals without the candidate list (the modal fetches that per ticker). */
export type SignalsScreenRow = Omit<TickerSignals, "candidates">;
