import { db } from "../db/connection.js";
import { requireEnvironmentVariable } from "../config/env.js";

// Risk-free rate for the P(d2) success probability: FRED's TB3MS (3-month
// T-bill, monthly), same series menaris-admin-api's saxo-service.js uses.
// Persisted in risk_free_rates rather than held in memory so a web-dyno
// restart, or a FRED outage right after one, still finds the last good rate.
//
// Refetches only when the stored row is older than the freshness window
// (TB3MS only changes monthly). If FRED fails, keeps serving the stored
// value and logs a warning. Returns null only when nothing has ever been
// stored AND FRED can't be reached — callers must show "—", never assume 0%.
//
// FRED_API_KEY is read lazily at call time (not via config/env.ts's eager
// `environment` object) so this doesn't force every process that imports
// env.ts to have it set — see the shared-env.ts note in PROGRESS.md.

const fredSeriesId = "TB3MS";
const freshnessWindowMs = 20 * 24 * 60 * 60 * 1000;
// The capture job retries 3 times (10 s each, 2 s / 4 s pauses; approved 2026-09-30): the first prod capture lost
// its only 8 s attempt to a timeout and saved every snapshot without a rate. Request paths (positions, order review)
// never wait for retries: the router gives up at 30 s, so they use one attempt and, when any stored rate exists,
// answer from it immediately while the refresh runs in the background.
const fredRequestTimeoutMs = 10_000;
const jobFredAttempts = 3;
const fredRetryBackoffMs = [2_000, 4_000];
/** After a failed refresh, do not try again for this long (a FRED outage must not make every request pay for it). */
const refreshFailureBackoffMs = 5 * 60_000;
let lastRefreshFailureAt: number | null = null;

let inFlightRefresh: Promise<number | null> | null = null;

async function readStoredRate(): Promise<{ ratePercent: number; fetchedAt: Date } | null> {
  const row = await db("risk_free_rates").where({ series_id: fredSeriesId }).first();
  if (!row) return null;
  return { ratePercent: Number(row.rate_percent), fetchedAt: new Date(row.fetched_at) };
}

/** Runs `operation` up to `attempts` times, pausing backoffMs[i] after failed attempt i; throws the last error. */
export async function runWithRetries<T>(operation: () => Promise<T>, attempts: number, backoffMs: number[], sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0);
    }
  }
  throw lastError;
}

async function fetchAndStoreFromFred(attempts: number): Promise<number> {
  const apiKey = requireEnvironmentVariable("FRED_API_KEY");
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", fredSeriesId);
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "1");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");

  const body = await runWithRetries(
    async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(fredRequestTimeoutMs) });
      if (!response.ok) throw new Error(`FRED responded ${response.status}`);
      return (await response.json()) as { observations?: { date: string; value: string }[] };
    },
    attempts,
    fredRetryBackoffMs,
  );
  const latestObservation = body.observations?.[0];
  if (!latestObservation) throw new Error("FRED returned no observations");
  const ratePercent = parseFloat(latestObservation.value);
  if (!Number.isFinite(ratePercent)) throw new Error(`FRED returned a non-numeric value: ${latestObservation.value}`);

  await db("risk_free_rates")
    .insert({
      series_id: fredSeriesId,
      rate_percent: ratePercent,
      observation_date: latestObservation.date,
      fetched_at: new Date(),
    })
    .onConflict("series_id")
    .merge();
  return ratePercent;
}

export interface GetRiskFreeRateOptions {
  /** Wait for a refresh even when a stored (stale) rate could be returned at once. Used by the capture job, which stores the rate. */
  waitForRefresh?: boolean;
  /** FRED attempts for a refresh started by this call. Jobs pass 3; request paths keep the default of 1. */
  attempts?: number;
}

/** Annual risk-free rate as a decimal (0.04 = 4%), or null if none is available. */
export async function getRiskFreeRate(options: GetRiskFreeRateOptions = {}): Promise<number | null> {
  const { waitForRefresh = false, attempts = 1 } = options;
  const stored = await readStoredRate();
  if (stored && Date.now() - stored.fetchedAt.getTime() < freshnessWindowMs) return stored.ratePercent / 100;

  const recentlyFailed = lastRefreshFailureAt !== null && Date.now() - lastRefreshFailureAt < refreshFailureBackoffMs;
  if (recentlyFailed && !waitForRefresh) return stored ? stored.ratePercent / 100 : null;

  // Concurrent callers (several streams opening at once) share one FRED call.
  inFlightRefresh ??= fetchAndStoreFromFred(attempts)
    .then((ratePercent) => {
      lastRefreshFailureAt = null;
      return ratePercent;
    })
    .catch((error) => {
      lastRefreshFailureAt = Date.now();
      console.warn(`riskFreeRate: FRED refresh failed after ${attempts} attempt(s) — ${error instanceof Error ? error.message : error}`);
      return stored ? stored.ratePercent : null;
    })
    .finally(() => {
      inFlightRefresh = null;
    });
  // A stored rate, even a stale one, is served at once on request paths; the refresh finishes in the background.
  if (stored && !waitForRefresh) return stored.ratePercent / 100;
  const ratePercent = await inFlightRefresh;
  return ratePercent === null ? null : ratePercent / 100;
}

/** The capture job's call: waits for the refresh and retries (see jobFredAttempts). */
export function getRiskFreeRateForJob(): Promise<number | null> {
  return getRiskFreeRate({ waitForRefresh: true, attempts: jobFredAttempts });
}
