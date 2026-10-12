import { captureAttemptsPerTicker, loadCaptureRetryCandidateRows, selectSymbolsToRetry } from "../lib/captureRetryQueue.js";
import { fitAndStoreSurfacesForDate } from "../lib/optionSurfaceStore.js";
import { holdCaptureLineReservation, loadCaptureUniverse, runOptionChainCapture, waitForCaptureLinesToFitBudget, type CaptureRunLineUsage, type OptionChainCaptureEvent } from "./runOptionChainCapture.js";

// Retry rounds of the morning capture (approved 2026-09-30), run after the first capture + fit pass:
// every ticker whose surface came out unusable (see selectSymbolsToRetry) goes into a queue, which is
// re-captured and re-fitted as a whole. The last attempt's data is the data that stays; a retry replaces
// the earlier snapshot, whichever of the attempts was better. No fixed pause before a round (Marcelo
// 2026-10-12, was 30 s): a round starts minutes after the ticker's first capture anyway, and the lines
// only need the live pool to shed once, which the ledger wait covers.

export interface CaptureRetryDependencies {
  findSymbolsToRetry: (tradingDate: string) => Promise<string[]>;
  holdLines: () => Promise<() => Promise<void>>;
  /** After reserving, until the live pool has shed to fit the budget (the main run's wait). */
  waitForPoolShedding: () => Promise<void>;
  /** `linesHeldSince` (ms since epoch) lets the round's logs count the held lines' idle time from the reservation. */
  recapture: (symbols: string[], round: { attempt: number; linesHeldSince: number }) => Promise<CaptureRunLineUsage | null>;
  refit: (tradingDate: string, symbols: string[]) => Promise<void>;
  now: () => number;
}

/** Where the lines held across the retry rounds spent their time, in ms; only capturingMs has anything subscribed. */
export interface CaptureRetryLineHold {
  totalHeldMs: number;
  poolWaitMs: number;
  capturingMs: number;
  refittingMs: number;
  choosingNextQueueMs: number;
}

export interface CaptureRetryResult {
  /** The queue of each retry round that ran, in order. */
  roundSymbols: string[][];
  /** Errors from a round's capture (a dropped connection, say); the next round still runs. */
  roundErrors: string[];
  /** Still below the bar after the last attempt. */
  stillFailingSymbols: string[];
  /** Each round's capture line usage, in order (null for a round whose capture threw). */
  roundLineUsage: (CaptureRunLineUsage | null)[];
  /** Null when nothing needed a retry, so no lines were held. */
  lineHold: CaptureRetryLineHold | null;
}

export async function runCaptureRetryRounds(tradingDate: string, dependencies: CaptureRetryDependencies): Promise<CaptureRetryResult> {
  const result: CaptureRetryResult = { roundSymbols: [], roundErrors: [], stillFailingSymbols: [], roundLineUsage: [], lineHold: null };
  let queue = await dependencies.findSymbolsToRetry(tradingDate);
  if (queue.length === 0) return result;

  // Lines are reserved once and kept between rounds, so the live pool sheds for them once, before the first round.
  const releaseLines = await dependencies.holdLines();
  const linesHeldSince = dependencies.now();
  const hold: CaptureRetryLineHold = { totalHeldMs: 0, poolWaitMs: 0, capturingMs: 0, refittingMs: 0, choosingNextQueueMs: 0 };
  const timed = async <T>(phase: Exclude<keyof CaptureRetryLineHold, "totalHeldMs">, work: () => Promise<T>): Promise<T> => {
    const startedAt = dependencies.now();
    try {
      return await work();
    } finally {
      hold[phase] += dependencies.now() - startedAt;
    }
  };
  try {
    await timed("poolWaitMs", () => dependencies.waitForPoolShedding());
    for (let attempt = 2; attempt <= captureAttemptsPerTicker && queue.length > 0; attempt++) {
      result.roundSymbols.push(queue);
      const symbols = queue;
      try {
        result.roundLineUsage.push(await timed("capturingMs", () => dependencies.recapture(symbols, { attempt, linesHeldSince })));
      } catch (error) {
        result.roundLineUsage.push(null);
        result.roundErrors.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await timed("refittingMs", () => dependencies.refit(tradingDate, symbols));
      queue = await timed("choosingNextQueueMs", () => dependencies.findSymbolsToRetry(tradingDate));
    }
  } finally {
    await releaseLines();
    hold.totalHeldMs = dependencies.now() - linesHeldSince;
    result.lineHold = hold;
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    console.log(
      `Capture retry: lines held ${seconds(hold.totalHeldMs)} over ${result.roundSymbols.length} round(s) — ${seconds(hold.poolWaitMs)} waiting for the pool to shed, ` +
        `${seconds(hold.capturingMs)} capturing, ${seconds(hold.refittingMs)} refitting, ${seconds(hold.choosingNextQueueMs)} choosing the next queue; only the capturing part subscribes anything.`,
    );
  }
  result.stillFailingSymbols = queue;
  return result;
}

export function buildDefaultCaptureRetryDependencies(onCaptureEvent: (event: OptionChainCaptureEvent) => void): CaptureRetryDependencies {
  return {
    findSymbolsToRetry: async (tradingDate) => selectSymbolsToRetry(await loadCaptureRetryCandidateRows(tradingDate, await loadCaptureUniverse())),
    holdLines: () => holdCaptureLineReservation(),
    waitForPoolShedding: waitForCaptureLinesToFitBudget,
    recapture: async (symbols, round) => (await runOptionChainCapture(onCaptureEvent, undefined, { symbols, linesHeldSince: round.linesHeldSince, runLabel: `Capture retry attempt ${round.attempt}` })).lineUsage,
    refit: async (tradingDate, symbols) => {
      await fitAndStoreSurfacesForDate(tradingDate, (event) => console.log(`${event.symbol}: ${event.outcome} (${event.detail})`), symbols);
    },
    now: Date.now,
  };
}

/** One line for the job alert when tickers are still unusable after every attempt, or undefined when none is. Free of "): " (the Telegram summary truncates there). */
export function buildCaptureRetryFailureMessage(result: CaptureRetryResult): string | undefined {
  const problems: string[] = [];
  if (result.stillFailingSymbols.length > 0) problems.push(`${result.stillFailingSymbols.length} tickers still have fewer than half of their expiries fitted after ${captureAttemptsPerTicker} attempts: ${result.stillFailingSymbols.join(", ")}`);
  if (result.roundErrors.length > 0) problems.push(`retry capture errors: ${result.roundErrors.join(" / ")}`);
  return problems.length > 0 ? problems.join("; ") : undefined;
}
