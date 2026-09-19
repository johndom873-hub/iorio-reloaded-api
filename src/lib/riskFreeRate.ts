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
const fredRequestTimeoutMs = 8_000;

let inFlightRefresh: Promise<number | null> | null = null;

async function readStoredRate(): Promise<{ ratePercent: number; fetchedAt: Date } | null> {
  const row = await db("risk_free_rates").where({ series_id: fredSeriesId }).first();
  if (!row) return null;
  return { ratePercent: Number(row.rate_percent), fetchedAt: new Date(row.fetched_at) };
}

async function fetchAndStoreFromFred(): Promise<number> {
  const apiKey = requireEnvironmentVariable("FRED_API_KEY");
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", fredSeriesId);
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "1");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");

  const response = await fetch(url, { signal: AbortSignal.timeout(fredRequestTimeoutMs) });
  if (!response.ok) throw new Error(`FRED responded ${response.status}`);
  const body = (await response.json()) as { observations?: { date: string; value: string }[] };
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

/** Annual risk-free rate as a decimal (0.04 = 4%), or null if none is available. */
export async function getRiskFreeRate(): Promise<number | null> {
  const stored = await readStoredRate();
  if (stored && Date.now() - stored.fetchedAt.getTime() < freshnessWindowMs) return stored.ratePercent / 100;

  // Concurrent callers (several streams opening at once) share one FRED call.
  inFlightRefresh ??= fetchAndStoreFromFred()
    .catch((error) => {
      console.warn(`riskFreeRate: FRED refresh failed — ${error instanceof Error ? error.message : error}`);
      return stored ? stored.ratePercent : null;
    })
    .finally(() => {
      inFlightRefresh = null;
    });
  const ratePercent = await inFlightRefresh;
  return ratePercent === null ? null : ratePercent / 100;
}
