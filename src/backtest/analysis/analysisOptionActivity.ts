import type { DatabaseSync } from "node:sqlite";

// The Analyse window's Options volume and Open interest tiles (Marcelo 2026-10-19), from the data file's end-of-day volumes
// and open interest (ThetaData), every contract counted. "Capped Puts" are the Puts at or under that day's first-rung cap,
// the ones the ladder sells.

/** The volume average's window and the comparison's. */
export const optionVolumeRecentSessions = 21;
export const optionVolumeYearSessions = 252;

export interface AnalysisOptionActivity {
  volume: {
    /** Sessions in the recent average (up to 21) and their range. */
    sessions: number;
    fromDate: string;
    toDate: string;
    /** Contracts a day, Calls and Puts. */
    averagePerDay: number;
    /** Calls' share of the recent volume; null with no volume. */
    callShare: number | null;
    /** Contracts a day of Puts at or under the day's first-rung cap, over the recent sessions with a cap. */
    cappedPutsAveragePerDay: number | null;
    /** The last 252 sessions' average, for comparison. */
    yearSessions: number;
    yearAveragePerDay: number;
  } | null;
  openInterest: {
    date: string;
    /** Open contracts, Calls and Puts. */
    total: number;
    callShare: number | null;
    /** Open contracts of Puts at or under that day's first-rung cap; null with no cap that day. */
    cappedPuts: number | null;
  } | null;
}

const hasTable = (database: DatabaseSync, name: string) => database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Volume and open interest up to `lastDate`; `capByDate` holds each scanned day's first-rung cap. */
export function computeOptionActivity(database: DatabaseSync, lastDate: string, capByDate: ReadonlyMap<string, number>): AnalysisOptionActivity {
  return { volume: hasTable(database, "eod") ? volumeOf(database, lastDate, capByDate) : null, openInterest: hasTable(database, "open_interest") ? openInterestOf(database, lastDate, capByDate) : null };
}

function volumeOf(database: DatabaseSync, lastDate: string, capByDate: ReadonlyMap<string, number>): AnalysisOptionActivity["volume"] {
  const rows = database
    .prepare("SELECT trading_date AS date, option_right AS right, SUM(volume) AS volume FROM eod WHERE trading_date <= ? GROUP BY trading_date, option_right ORDER BY trading_date DESC LIMIT ?")
    .all(lastDate, optionVolumeYearSessions * 2) as { date: string; right: string; volume: number | null }[];
  const byDate = new Map<string, { calls: number; puts: number }>();
  for (const row of rows) {
    const day = byDate.get(row.date) ?? byDate.set(row.date, { calls: 0, puts: 0 }).get(row.date)!;
    if (row.right === "C") day.calls += row.volume ?? 0;
    else day.puts += row.volume ?? 0;
  }
  const dates = [...byDate.keys()].sort().reverse().slice(0, optionVolumeYearSessions);
  if (dates.length === 0) return null;
  const recent = dates.slice(0, optionVolumeRecentSessions);
  const total = (date: string) => byDate.get(date)!.calls + byDate.get(date)!.puts;
  const recentCalls = recent.reduce((sum, date) => sum + byDate.get(date)!.calls, 0);
  const recentTotal = recent.reduce((sum, date) => sum + total(date), 0);

  const cappedDates = recent.filter((date) => capByDate.has(date));
  let cappedPutsAveragePerDay: number | null = null;
  if (cappedDates.length > 0) {
    const putRows = database
      .prepare(`SELECT trading_date AS date, strike, SUM(volume) AS volume FROM eod WHERE option_right = 'P' AND trading_date IN (${cappedDates.map(() => "?").join(", ")}) GROUP BY trading_date, strike`)
      .all(...cappedDates) as { date: string; strike: number; volume: number | null }[];
    const capped = putRows.filter((row) => row.strike <= capByDate.get(row.date)! + 1e-9).reduce((sum, row) => sum + (row.volume ?? 0), 0);
    cappedPutsAveragePerDay = capped / cappedDates.length;
  }
  return {
    sessions: recent.length,
    fromDate: recent.at(-1)!,
    toDate: recent[0]!,
    averagePerDay: recentTotal / recent.length,
    callShare: recentTotal > 0 ? recentCalls / recentTotal : null,
    cappedPutsAveragePerDay,
    yearSessions: dates.length,
    yearAveragePerDay: dates.reduce((sum, date) => sum + total(date), 0) / dates.length,
  };
}

function openInterestOf(database: DatabaseSync, lastDate: string, capByDate: ReadonlyMap<string, number>): AnalysisOptionActivity["openInterest"] {
  const latest = (database.prepare("SELECT MAX(trading_date) AS date FROM open_interest WHERE trading_date <= ?").get(lastDate) as { date: string | null }).date;
  if (latest === null) return null;
  const rows = database.prepare("SELECT option_right AS right, strike, SUM(open_interest) AS openInterest FROM open_interest WHERE trading_date = ? GROUP BY option_right, strike").all(latest) as { right: string; strike: number; openInterest: number | null }[];
  const calls = rows.filter((row) => row.right === "C").reduce((sum, row) => sum + (row.openInterest ?? 0), 0);
  const puts = rows.filter((row) => row.right !== "C").reduce((sum, row) => sum + (row.openInterest ?? 0), 0);
  const cap = capByDate.get(latest);
  return {
    date: latest,
    total: calls + puts,
    callShare: calls + puts > 0 ? calls / (calls + puts) : null,
    cappedPuts: cap === undefined ? null : rows.filter((row) => row.right !== "C" && row.strike <= cap + 1e-9).reduce((sum, row) => sum + (row.openInterest ?? 0), 0),
  };
}
