import { fetchCachedPriceBars } from "../ibkr/priceBarCache.js";
import { JobAlreadyRunningError, runJob } from "./runJob.js";
import { getPricePerformanceSnapshot, invalidatePricePerformanceSnapshot } from "./pricePerformanceSnapshot.js";

// The ONLY IBKR reads the Price Performance page can cause: an explicit
// "Refresh daily data" click (design decision 4, 2026-09-20). It fetches just
// the tickers whose latest completed bar is older than the last completed
// session — nothing when the data is already current — one at a time in small
// batches (IBKR historical-data pacing), and refuses to overlap itself or run
// again within the cooldown. Page loads never come through here.

const batchSize = 4;
const cooldownMs = 2 * 60 * 1000;
export const priceBarsRefreshJobName = "price_bars_refresh";

let isRunning = false;
let lastFinishedAtMs: number | null = null;

function markRefreshFinished(): void {
  isRunning = false;
  lastFinishedAtMs = Date.now();
  invalidatePricePerformanceSnapshot();
}

export interface PriceBarsRefreshStatus {
  isRunning: boolean;
  lastFinishedAt: string | null;
  cooldownRemainingSeconds: number;
}

export function getPriceBarsRefreshStatus(now: number = Date.now()): PriceBarsRefreshStatus {
  const cooldownRemainingMs = lastFinishedAtMs === null ? 0 : Math.max(0, lastFinishedAtMs + cooldownMs - now);
  return {
    isRunning,
    lastFinishedAt: lastFinishedAtMs === null ? null : new Date(lastFinishedAtMs).toISOString(),
    cooldownRemainingSeconds: Math.ceil(cooldownRemainingMs / 1000),
  };
}

export type StartPriceBarsRefreshResult =
  | { status: "started"; symbolCount: number }
  | { status: "upToDate" }
  | { status: "alreadyRunning" }
  | { status: "cooldown"; retryAfterSeconds: number };

export async function startPriceBarsRefresh(triggeredByUserId: string): Promise<StartPriceBarsRefreshResult> {
  if (isRunning) return { status: "alreadyRunning" };
  const { cooldownRemainingSeconds } = getPriceBarsRefreshStatus();
  if (cooldownRemainingSeconds > 0) return { status: "cooldown", retryAfterSeconds: cooldownRemainingSeconds };

  const symbols = (await getPricePerformanceSnapshot()).meta.refreshableSymbols;
  if (symbols.length === 0) return { status: "upToDate" };
  // Re-check after the await: a second click could have got past the first guard meanwhile.
  if (isRunning) return { status: "alreadyRunning" };
  isRunning = true;

  // Runs in the background (a page must never wait on IBKR); the job_completed
  // notification runJob publishes tells open pages to reload.
  void runJob(
    priceBarsRefreshJobName,
    async () => {
      let succeeded = 0;
      const failedSymbols: string[] = [];
      try {
        for (let start = 0; start < symbols.length; start += batchSize) {
          const batch = symbols.slice(start, start + batchSize);
          const outcomes = await Promise.allSettled(batch.map((symbol) => fetchCachedPriceBars(symbol, "1Y")));
          outcomes.forEach((outcome, index) => {
            if (outcome.status === "fulfilled") succeeded += 1;
            else failedSymbols.push(batch[index]!);
          });
        }
      } finally {
        // Before runJob publishes job_completed: a page that reloads on that
        // notification must already see the new data and an idle refresh state.
        markRefreshFinished();
      }
      if (succeeded === 0) throw new Error(`Price data refresh failed for every ticker (${failedSymbols.join(", ")}) — IBKR historical data unavailable.`);
      return { details: { requested: symbols.length, succeeded, failedSymbols } };
    },
    { triggeredBy: "manual", triggeredByUserId },
  )
    .catch((error) => {
      if (!(error instanceof JobAlreadyRunningError)) console.error("price_bars_refresh failed:", error);
    })
    .finally(markRefreshFinished);

  return { status: "started", symbolCount: symbols.length };
}
