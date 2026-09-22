// Batching, coverage and status rules for the nightly option-chain archive
// (IORIO Signal Engine, Phase 0). All parameters below were approved as
// starting values on 2026-09-21, to be tuned after the first live test.

/** ~60 live quote lines per batch: IBKR's ~100-line quota is shared across the whole Gateway, so this leaves headroom for a person opening Ticker Detail. */
export const optionChainCaptureBatchSize = 60;

/** A ticker is "starved" when fewer than this fraction of its requested contracts received ANY tick. Not "two-sided quote": far-OTM contracts legitimately have no bid. */
export const starvedTickerAnyTickFraction = 0.9;

/** Starved tickers are re-captured once, only if the job is still younger than this... */
export const recaptureMaximumElapsedMs = 45 * 60 * 1000;
/** ...and the whole re-capture pass is capped at this long. */
export const recapturePassMaximumDurationMs = 10 * 60 * 1000;

export function splitIntoBatches<T>(items: T[], batchSize: number = optionChainCaptureBatchSize): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError(`batchSize must be a positive integer, got ${batchSize}`);
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) batches.push(items.slice(start, start + batchSize));
  return batches;
}

export interface CoverageQuoteInput {
  receivedAnyTick: boolean;
  bid: number | null;
  ask: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  sawRealTimeTicks: boolean;
  sawDelayedTicks: boolean;
}

export interface SnapshotCoverage {
  contractsRequested: number;
  contractsWithAnyTick: number;
  contractsWithTwoSidedQuote: number;
  contractsWithImpliedVolatility: number;
}

export function computeSnapshotCoverage(quotes: CoverageQuoteInput[]): SnapshotCoverage {
  return {
    contractsRequested: quotes.length,
    contractsWithAnyTick: quotes.filter((quote) => quote.receivedAnyTick).length,
    contractsWithTwoSidedQuote: quotes.filter((quote) => quote.bid !== null && quote.ask !== null).length,
    // Matches the approved header field: "contracts with IV and delta".
    contractsWithImpliedVolatility: quotes.filter((quote) => quote.impliedVolatility !== null && quote.delta !== null).length,
  };
}

/** True when fewer than 90% of requested contracts received any tick. A ticker with nothing requested is not "starved" — that is a different problem. */
export function isTickerStarved(coverage: SnapshotCoverage): boolean {
  if (coverage.contractsRequested === 0) return false;
  return coverage.contractsWithAnyTick / coverage.contractsRequested < starvedTickerAnyTickFraction;
}

export type OptionChainSnapshotStatus = "complete" | "partial" | "failed";

/** complete = not starved; partial = some ticks but starved; failed = requested contracts but no ticks at all (or none requested). */
export function deriveSnapshotStatus(coverage: SnapshotCoverage): OptionChainSnapshotStatus {
  if (coverage.contractsRequested === 0 || coverage.contractsWithAnyTick === 0) return "failed";
  return isTickerStarved(coverage) ? "partial" : "complete";
}

export type OptionChainMarketDataType = "real_time" | "delayed" | "mixed" | "unknown";

/** Judged from which tick types actually arrived (real-time bid=1/ask=2, delayed bid=66/ask=67), not from what was requested. */
export function deriveMarketDataType(quotes: CoverageQuoteInput[]): OptionChainMarketDataType {
  const sawRealTime = quotes.some((quote) => quote.sawRealTimeTicks);
  const sawDelayed = quotes.some((quote) => quote.sawDelayedTicks);
  if (sawRealTime && sawDelayed) return "mixed";
  if (sawRealTime) return "real_time";
  if (sawDelayed) return "delayed";
  return "unknown";
}

/** The single re-capture rule: starved, and the job is still inside its elapsed-time budget. */
export function shouldRecaptureStarvedTicker(coverage: SnapshotCoverage, jobElapsedMs: number): boolean {
  return isTickerStarved(coverage) && jobElapsedMs < recaptureMaximumElapsedMs;
}
