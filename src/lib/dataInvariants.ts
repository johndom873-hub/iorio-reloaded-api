import { db } from "../db/connection.js";
import { loadOptionDataUniverse } from "./optionDataUniverse.js";
import { lastCompletedSessionDate } from "./marketSessionStatus.js";
import { activeShortlistTickerIdsQuery } from "./shortlistQueries.js";
import { excludeTickersBeingPrepared } from "./tickersBeingPrepared.js";
import { earningsNextDateDoubt, earningsNextDateMaxGapDays, earningsNextDateMissingAfterDays } from "./tickerCalendarRelevance.js";

// Data invariants for the morning digest (opsMonitor.ts): checks on the DATA the nightly and
// opening jobs produce, independent of whether the jobs themselves reported success. A job that
// "succeeded" with a null risk-free rate or stale bars is exactly what runJob cannot see.
// Thresholds approved 2026-09-30.

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

export interface DataInvariantInputs {
  now: Date;
  universeSymbols: string[];
  lastCompletedSession: string;
  latestBarDateBySymbol: Record<string, string | null>;
  riskFreeRateFetchedAt: Date | null;
  marketCalendarDaysAhead: number;
  latestTickerCalendarCapturedAt: Date | null;
  latestMajorMacroEventsCapturedAt: Date | null;
  /** Earnings dates (YYYY-MM-DD) from earningsDatesLookbackDays ago on, per universe ticker. */
  earningsDatesBySymbol: Record<string, string[]>;
  /** Per universe ticker with any earnings date: the last report and the next date, as earningsNextDateDoubt reads them. */
  earningsReportDatesBySymbol: Record<string, { lastReportIso: string | null; nextReportIso: string | null }>;
  /** The trading date the checks describe (the earnings pairs that matter reach it or later). */
  todayEasternIso: string;
}

const list = (symbols: string[]): string => symbols.join(", ");
const hoursSince = (now: Date, instant: Date): number => (now.getTime() - instant.getTime()) / 3_600_000;

function result(name: string, problemSymbols: string[], okDetail: string, problemDetail: string): InvariantResult {
  return problemSymbols.length === 0 ? { name, ok: true, detail: okDetail } : { name, ok: false, detail: `${problemDetail}: ${list(problemSymbols)}` };
}

/** Pure: every invariant, in digest order. */
export function evaluateDataInvariants(input: DataInvariantInputs): InvariantResult[] {
  const results: InvariantResult[] = [];
  if (input.universeSymbols.length === 0) {
    results.push({ name: "Option-data universe", ok: false, detail: "no tickers to track (shortlist and open positions are both empty)" });
  }

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
  const doubtfulNextDates = Object.entries(input.earningsReportDatesBySymbol).flatMap(([symbol, { lastReportIso, nextReportIso }]) =>
    earningsNextDateDoubt(lastReportIso, nextReportIso, input.todayEasternIso) === null ? [] : [`${symbol} (last ${lastReportIso}, next ${nextReportIso ?? "none"})`],
  );
  results.push(
    result(
      "Next earnings date",
      doubtfulNextDates,
      `every ticker's next earnings date is within ${earningsNextDateMaxGapDays} days of its last report`,
      `doubtful (more than ${earningsNextDateMaxGapDays} days after the last report, or none ${earningsNextDateMissingAfterDays} days after it), so left unresolved and Pluto won't open`,
    ),
  );
  return results;
}

/** Reads the real tables. `todayEasternIso` is the trading date the checks describe. */
export async function loadDataInvariantInputs(now: Date, todayEasternIso: string): Promise<DataInvariantInputs> {
  const universe = await loadOptionDataUniverse({ excludeBeingPrepared: true });
  const universeTickerIds = universe.map((ticker) => ticker.tickerId);

  const lastCompletedSession = await lastCompletedSessionDate(now);
  const barRows: { symbol: string; latest: string | null }[] = await excludeTickersBeingPrepared(
    db("tickers as t").where((builder) => builder.whereIn("t.id", universeTickerIds).orWhereIn("t.id", activeShortlistTickerIdsQuery())),
    "t.id",
  )
    .leftJoin("daily_price_bars as b", "b.ticker_id", "t.id")
    .groupBy("t.symbol")
    .select("t.symbol", db.raw("max(b.trading_date)::text as latest"));

  const [rateRow, calendarRow, tickerCalendarRow, majorMacroEventsRow, earningsRows, earningsReportDateRows] = await Promise.all([
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
    // Last report and next date, split at today (today's before-open report is the last).
    db("ticker_calendar_events as e")
      .join("tickers as t", "t.id", "e.ticker_id")
      .whereIn("e.ticker_id", universeTickerIds)
      .where("e.event_type", "earnings")
      .groupBy("t.symbol")
      .select(
        "t.symbol",
        db.raw(`(max(e.event_date) filter (where e.event_date < ?::date or (e.event_date = ?::date and e.event_time is not distinct from '-1')))::text as "lastReportIso"`, [todayEasternIso, todayEasternIso]),
        db.raw(`(min(e.event_date) filter (where e.event_date > ?::date or (e.event_date = ?::date and e.event_time is distinct from '-1')))::text as "nextReportIso"`, [todayEasternIso, todayEasternIso]),
      ) as Promise<{ symbol: string; lastReportIso: string | null; nextReportIso: string | null }[]>,
  ]);
  const earningsDatesBySymbol: Record<string, string[]> = {};
  for (const row of earningsRows) (earningsDatesBySymbol[row.symbol] ??= []).push(row.date);

  return {
    now,
    universeSymbols: universe.map((ticker) => ticker.symbol),
    lastCompletedSession,
    latestBarDateBySymbol: Object.fromEntries(barRows.map((row) => [row.symbol, row.latest])),
    riskFreeRateFetchedAt: rateRow?.fetched_at ? new Date(rateRow.fetched_at) : null,
    marketCalendarDaysAhead: Number(calendarRow?.count ?? 0),
    latestTickerCalendarCapturedAt: tickerCalendarRow?.captured_at ? new Date(tickerCalendarRow.captured_at) : null,
    latestMajorMacroEventsCapturedAt: majorMacroEventsRow?.captured_at ? new Date(majorMacroEventsRow.captured_at) : null,
    earningsDatesBySymbol,
    earningsReportDatesBySymbol: Object.fromEntries(earningsReportDateRows.map((row) => [row.symbol, { lastReportIso: row.lastReportIso, nextReportIso: row.nextReportIso }])),
    todayEasternIso,
  };
}
