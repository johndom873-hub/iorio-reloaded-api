import { captureAttemptsPerTicker, captureRetryDelayMs, loadCaptureRetryCandidateRows, selectSymbolsToRetry } from "../lib/captureRetryQueue.js";
import { fitAndStoreSurfacesForDate } from "../lib/optionSurfaceStore.js";
import { holdCaptureLineReservation, loadCaptureUniverse, runOptionChainCapture, type OptionChainCaptureEvent } from "./runOptionChainCapture.js";

// Retry rounds of the morning capture (approved 2026-09-30), run after the first capture + fit pass:
// every ticker whose surface came out unusable (see selectSymbolsToRetry) goes into a queue, which is
// re-captured and re-fitted as a whole after ONE pause per round. The last attempt's data is the data
// that stays; a retry replaces the earlier snapshot, whichever of the attempts was better.

export interface CaptureRetryDependencies {
  findSymbolsToRetry: (tradingDate: string) => Promise<string[]>;
  holdLines: () => Promise<() => Promise<void>>;
  sleep: (milliseconds: number) => Promise<void>;
  recapture: (symbols: string[]) => Promise<void>;
  refit: (tradingDate: string, symbols: string[]) => Promise<void>;
}

export interface CaptureRetryResult {
  /** The queue of each retry round that ran, in order. */
  roundSymbols: string[][];
  /** Errors from a round's capture (a dropped connection, say); the next round still runs. */
  roundErrors: string[];
  /** Still below the bar after the last attempt. */
  stillFailingSymbols: string[];
}

export async function runCaptureRetryRounds(tradingDate: string, dependencies: CaptureRetryDependencies): Promise<CaptureRetryResult> {
  const result: CaptureRetryResult = { roundSymbols: [], roundErrors: [], stillFailingSymbols: [] };
  let queue = await dependencies.findSymbolsToRetry(tradingDate);
  if (queue.length === 0) return result;

  // Lines are reserved once and kept between rounds. The first round's pause also covers the live pool shedding its lines to make room.
  const releaseLines = await dependencies.holdLines();
  try {
    for (let attempt = 2; attempt <= captureAttemptsPerTicker && queue.length > 0; attempt++) {
      await dependencies.sleep(captureRetryDelayMs);
      result.roundSymbols.push(queue);
      try {
        await dependencies.recapture(queue);
      } catch (error) {
        result.roundErrors.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await dependencies.refit(tradingDate, queue);
      queue = await dependencies.findSymbolsToRetry(tradingDate);
    }
  } finally {
    await releaseLines();
  }
  result.stillFailingSymbols = queue;
  return result;
}

export function buildDefaultCaptureRetryDependencies(onCaptureEvent: (event: OptionChainCaptureEvent) => void): CaptureRetryDependencies {
  return {
    findSymbolsToRetry: async (tradingDate) => selectSymbolsToRetry(await loadCaptureRetryCandidateRows(tradingDate, await loadCaptureUniverse())),
    holdLines: () => holdCaptureLineReservation(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    recapture: async (symbols) => {
      await runOptionChainCapture(onCaptureEvent, undefined, { symbols, linesAlreadyHeld: true });
    },
    refit: async (tradingDate, symbols) => {
      await fitAndStoreSurfacesForDate(tradingDate, (event) => console.log(`${event.symbol}: ${event.outcome} (${event.detail})`), symbols);
    },
  };
}

/** One line for the job alert when tickers are still unusable after every attempt, or undefined when none is. Free of "): " (the Telegram summary truncates there). */
export function buildCaptureRetryFailureMessage(result: CaptureRetryResult): string | undefined {
  const problems: string[] = [];
  if (result.stillFailingSymbols.length > 0) problems.push(`${result.stillFailingSymbols.length} tickers still have fewer than half of their expiries fitted after ${captureAttemptsPerTicker} attempts: ${result.stillFailingSymbols.join(", ")}`);
  if (result.roundErrors.length > 0) problems.push(`retry capture errors: ${result.roundErrors.join(" / ")}`);
  return problems.length > 0 ? problems.join("; ") : undefined;
}
