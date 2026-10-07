import { db } from "../db/connection.js";
import { loadCaptureUniverse } from "../ibkr/runOptionChainCapture.js";
import { lastCompletedSessionDate } from "./marketSessionStatus.js";
import { activeShortlistTickerIdsQuery } from "./shortlistQueries.js";
import { excludeTickersBeingPrepared } from "./tickersBeingPrepared.js";
import { impliedVolatilityMinPercent, twoSidedQuoteMinPercent } from "./optionChainCaptureCoverage.js";

// Data invariants for the morning digest (opsMonitor.ts): checks on the DATA the nightly and
// opening jobs produce, independent of whether the jobs themselves reported success. A job that
// "succeeded" with a null risk-free rate, no fits or stale bars is exactly what runJob cannot see.
// Thresholds approved 2026-09-30; the coverage floors sit below the worst complete real-time
// snapshot seen in staging (two-sided 86.7%, implied volatility 84.8%).

export const riskFreeRateMaxAgeDays = 25;
export const marketCalendarCoverageDays = 14;
export const calendarEventDataMaxAgeHours = 36;
/** Two earnings dates of one ticker closer than this are a data error: reports come about every 91 days (approved 2026-10-07). */
export const earningsDatesMinGapDays = 45;
/** How far back the earnings check looks: the older history (API Ninjas) has real same-week oddities that are harmless now. */
export const earningsDatesLookbackDays = 30;

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SnapshotFacts {
  symbol: string;
  status: string;
  riskFreeRatePercent: number | null;
  contractsRequested: number;
  contractsWithTwoSidedQuote: number;
  contractsWithImpliedVolatility: number;
  okFitCount: number;
}

export interface DataInvariantInputs {
  now: Date;
  universeSymbols: string[];
  /** Today's (Eastern) snapshots, one per symbol. */
  snapshots: SnapshotFacts[];
  dayPoolExpiryCount: number;
  lastCompletedSession: string;
  latestBarDateBySymbol: Record<string, string | null>;
  riskFreeRateFetchedAt: Date | null;
  marketCalendarDaysAhead: number;
  latestTickerCalendarCapturedAt: Date | null;
  latestMajorMacroEventsCapturedAt: Date | null;
  /** Earnings dates (YYYY-MM-DD) from earningsDatesLookbackDays ago on, per universe ticker. */
  earningsDatesBySymbol: Record<string, string[]>;
  /** The trading date the checks describe (the earnings pairs that matter reach it or later). */
  todayEasternIso: string;
}

const list = (symbols: string[]): string => symbols.join(", ");
const percent = (part: number, whole: number): number => (whole > 0 ? (100 * part) / whole : 0);
const hoursSince = (now: Date, instant: Date): number => (now.getTime() - instant.getTime()) / 3_600_000;

function result(name: string, problemSymbols: string[], okDetail: string, problemDetail: string): InvariantResult {
  return problemSymbols.length === 0 ? { name, ok: true, detail: okDetail } : { name, ok: false, detail: `${problemDetail}: ${list(problemSymbols)}` };
}

/** Pure: every invariant, in digest order. */
export function evaluateDataInvariants(input: DataInvariantInputs): InvariantResult[] {
  const results: InvariantResult[] = [];
  const snapshotBySymbol = new Map(input.snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
  // A failed snapshot is already reported as "not complete"; its zero coverage and null rate are not separate findings.
  const usableSnapshots = input.snapshots.filter((snapshot) => snapshot.status !== "failed");

  if (input.universeSymbols.length === 0) {
    results.push({ name: "Capture universe", ok: false, detail: "no tickers to capture (shortlist and open positions are both empty)" });
  }
  const missing = input.universeSymbols.filter((symbol) => !snapshotBySymbol.has(symbol));
  const notComplete = input.snapshots.filter((snapshot) => snapshot.status !== "complete").map((snapshot) => `${snapshot.symbol} (${snapshot.status})`);
  results.push(result("Today's option-chain snapshots", [...missing.map((symbol) => `${symbol} (missing)`), ...notComplete], `${input.snapshots.filter((snapshot) => snapshot.status === "complete" && input.universeSymbols.includes(snapshot.symbol)).length} of ${input.universeSymbols.length} complete`, "not complete"));

  results.push(result("Risk-free rate on snapshots", usableSnapshots.filter((snapshot) => snapshot.riskFreeRatePercent === null).map((snapshot) => snapshot.symbol), "present on every snapshot", "missing on"));
  results.push(
    result(
      "Two-sided quote coverage",
      usableSnapshots.filter((snapshot) => percent(snapshot.contractsWithTwoSidedQuote, snapshot.contractsRequested) < twoSidedQuoteMinPercent).map((snapshot) => `${snapshot.symbol} ${Math.round(percent(snapshot.contractsWithTwoSidedQuote, snapshot.contractsRequested))}%`),
      `at least ${twoSidedQuoteMinPercent}% on every snapshot`,
      `below ${twoSidedQuoteMinPercent}%`,
    ),
  );
  results.push(
    result(
      "Implied volatility coverage",
      usableSnapshots.filter((snapshot) => percent(snapshot.contractsWithImpliedVolatility, snapshot.contractsRequested) < impliedVolatilityMinPercent).map((snapshot) => `${snapshot.symbol} ${Math.round(percent(snapshot.contractsWithImpliedVolatility, snapshot.contractsRequested))}%`),
      `at least ${impliedVolatilityMinPercent}% on every snapshot`,
      `below ${impliedVolatilityMinPercent}%`,
    ),
  );
  results.push(result("Surface fits", input.snapshots.filter((snapshot) => snapshot.status !== "failed" && snapshot.okFitCount === 0).map((snapshot) => snapshot.symbol), "every snapshot has fitted expiries", "no fitted expiry for"));
  results.push(
    input.dayPoolExpiryCount > 0
      ? { name: "Day Signals pool", ok: true, detail: `${input.dayPoolExpiryCount} expiries seeded` }
      : { name: "Day Signals pool", ok: false, detail: "empty for today" },
  );

  const staleBars = Object.entries(input.latestBarDateBySymbol)
    .filter(([, latest]) => latest === null || latest < input.lastCompletedSession)
    .map(([symbol, latest]) => `${symbol} (${latest ?? "none"})`);
  results.push(result("Daily price bars", staleBars, `every ticker has the ${input.lastCompletedSession} bar`, `behind ${input.lastCompletedSession}`));

  if (input.riskFreeRateFetchedAt === null) results.push({ name: "Risk-free rate", ok: false, detail: "no rate stored in risk_free_rates" });
  else {
    const ageDays = hoursSince(input.now, input.riskFreeRateFetchedAt) / 24;
    results.push({ name: "Risk-free rate", ok: ageDays <= riskFreeRateMaxAgeDays, detail: `fetched ${Math.floor(ageDays)} day(s) ago${ageDays > riskFreeRateMaxAgeDays ? `, older than ${riskFreeRateMaxAgeDays} days` : ""}` });
  }
  results.push({
    name: "Market calendar",
    ok: input.marketCalendarDaysAhead >= marketCalendarCoverageDays,
    detail: `${input.marketCalendarDaysAhead} day(s) ahead${input.marketCalendarDaysAhead >= marketCalendarCoverageDays ? "" : `, needs ${marketCalendarCoverageDays}`}`,
  });
  for (const [name, capturedAt] of [
    ["Ticker calendar (earnings, dividends)", input.latestTickerCalendarCapturedAt],
    ["Major macro events", input.latestMajorMacroEventsCapturedAt],
  ] as const) {
    if (capturedAt === null) results.push({ name, ok: false, detail: "never captured" });
    else {
      const ageHours = hoursSince(input.now, capturedAt);
      results.push({ name, ok: ageHours <= calendarEventDataMaxAgeHours, detail: `captured ${Math.round(ageHours)} h ago${ageHours > calendarEventDataMaxAgeHours ? `, older than ${calendarEventDataMaxAgeHours} h` : ""}` });
    }
  }
  // Only a pair that reaches today or later matters: two sources disagreeing by a day about a past report is harmless.
  const tooClose = Object.entries(input.earningsDatesBySymbol).flatMap(([symbol, dates]) => {
    const sorted = [...dates].sort();
    const pair = sorted.slice(1).map((date, index) => [sorted[index]!, date] as const).find(([earlier, later]) => later >= input.todayEasternIso && (Date.parse(later) - Date.parse(earlier)) / 86_400_000 < earningsDatesMinGapDays);
    return pair ? [`${symbol} (${pair[0]} and ${pair[1]})`] : [];
  });
  results.push(result("Earnings dates", tooClose, `no ticker has two earnings dates within ${earningsDatesMinGapDays} days`, `two earnings dates within ${earningsDatesMinGapDays} days`));
  return results;
}

/** Reads the real tables. `todayEasternIso` is the capture's trading date. */
export async function loadDataInvariantInputs(now: Date, todayEasternIso: string): Promise<DataInvariantInputs> {
  const universe = await loadCaptureUniverse();
  const universeTickerIds = universe.map((ticker) => ticker.tickerId);

  const snapshotRows: {
    symbol: string;
    status: string;
    risk_free_rate_percent: string | null;
    contracts_requested: number;
    contracts_with_two_sided_quote: number;
    contracts_with_implied_volatility: number;
    ok_fit_count: string;
  }[] = await db("option_chain_snapshots as s")
    .join("tickers as t", "t.id", "s.ticker_id")
    .whereRaw("s.trading_date::text = ?", [todayEasternIso])
    .select(
      "t.symbol",
      "s.status",
      "s.risk_free_rate_percent",
      "s.contracts_requested",
      "s.contracts_with_two_sided_quote",
      "s.contracts_with_implied_volatility",
      db.raw("(select count(*) from option_surface_fits f where f.snapshot_id = s.id and f.status = 'ok') as ok_fit_count"),
    );

  const lastCompletedSession = await lastCompletedSessionDate(now);
  // Price bars cover the Signals-off shortlist tickers too: Price Performance reads them.
  const barRows: { symbol: string; latest: string | null }[] = await excludeTickersBeingPrepared(
    db("tickers as t").where((builder) => builder.whereIn("t.id", universeTickerIds).orWhereIn("t.id", activeShortlistTickerIdsQuery())),
    "t.id",
  )
    .leftJoin("daily_price_bars as b", "b.ticker_id", "t.id")
    .groupBy("t.symbol")
    .select("t.symbol", db.raw("max(b.trading_date)::text as latest"));

  const [poolRow, rateRow, calendarRow, tickerCalendarRow, majorMacroEventsRow, earningsRows] = await Promise.all([
    db("day_signal_expiries").whereRaw("trading_date::text = ?", [todayEasternIso]).count<{ count: string }[]>("* as count").first(),
    db("risk_free_rates").max<{ fetched_at: Date | null }[]>("fetched_at as fetched_at").first(),
    db("market_calendar").whereRaw("calendar_date > ?::date and calendar_date <= (?::date + ?::int)", [todayEasternIso, todayEasternIso, marketCalendarCoverageDays]).count<{ count: string }[]>("* as count").first(),
    db("ticker_calendar_events").max<{ captured_at: Date | null }[]>("captured_at as captured_at").first(),
    // The stalest source's latest capture: the election rows are rewritten daily, so a plain max would hide a source that stopped refreshing.
    db.raw(`SELECT min(latest_captured_at) AS captured_at FROM (SELECT max(captured_at) AS latest_captured_at FROM major_macro_events GROUP BY event_key) AS per_source`).then((result: { rows: { captured_at: Date | null }[] }) => result.rows[0]),
    db("ticker_calendar_events as e")
      .join("tickers as t", "t.id", "e.ticker_id")
      .whereIn("e.ticker_id", universeTickerIds)
      .where("e.event_type", "earnings")
      .whereRaw("e.event_date >= ?::date - ?::int", [todayEasternIso, earningsDatesLookbackDays])
      .select("t.symbol", db.raw("e.event_date::text as date")) as Promise<{ symbol: string; date: string }[]>,
  ]);
  const earningsDatesBySymbol: Record<string, string[]> = {};
  for (const row of earningsRows) (earningsDatesBySymbol[row.symbol] ??= []).push(row.date);

  return {
    now,
    universeSymbols: universe.map((ticker) => ticker.symbol),
    snapshots: snapshotRows.map((row) => ({
      symbol: row.symbol,
      status: row.status,
      riskFreeRatePercent: row.risk_free_rate_percent === null ? null : Number(row.risk_free_rate_percent),
      contractsRequested: Number(row.contracts_requested),
      contractsWithTwoSidedQuote: Number(row.contracts_with_two_sided_quote),
      contractsWithImpliedVolatility: Number(row.contracts_with_implied_volatility),
      okFitCount: Number(row.ok_fit_count),
    })),
    dayPoolExpiryCount: Number(poolRow?.count ?? 0),
    lastCompletedSession,
    latestBarDateBySymbol: Object.fromEntries(barRows.map((row) => [row.symbol, row.latest])),
    riskFreeRateFetchedAt: rateRow?.fetched_at ? new Date(rateRow.fetched_at) : null,
    marketCalendarDaysAhead: Number(calendarRow?.count ?? 0),
    latestTickerCalendarCapturedAt: tickerCalendarRow?.captured_at ? new Date(tickerCalendarRow.captured_at) : null,
    latestMajorMacroEventsCapturedAt: majorMacroEventsRow?.captured_at ? new Date(majorMacroEventsRow.captured_at) : null,
    earningsDatesBySymbol,
    todayEasternIso,
  };
}
