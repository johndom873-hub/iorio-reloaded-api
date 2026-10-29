import type { DatabaseSync } from "node:sqlite";
import { dailySliceLookMinute, dayNumberOf, dayNumberOfKey, decodeSlice, endOfDayColumns, isoDateOfDayNumber, openInterestColumns, sliceColumn, sliceKey, sliceValueAt } from "../engine/symbolFileSlices.js";

// The Analyse window's Options volume and Open interest tiles (Marcelo 2026-10-19), from the data file's end-of-day volumes
// and open interest (ThetaData), every contract counted. "Capped Puts" are the Puts at or under that day's first-rung cap,
// the ones the ladder sells. A schema 4 file gives the same figures from its slices.

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
  if (hasTable(database, "end_of_day_slices")) return { volume: volumeSummaryOf(sliceVolumeByDate(database, lastDate), capByDate, (dates) => slicePutVolumeUnderCaps(database, dates, capByDate)), openInterest: sliceOpenInterestOf(database, lastDate, capByDate) };
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
  return volumeSummaryOf(byDate, capByDate, (cappedDates) => {
    const putRows = database
      .prepare(`SELECT trading_date AS date, strike, SUM(volume) AS volume FROM eod WHERE option_right = 'P' AND trading_date IN (${cappedDates.map(() => "?").join(", ")}) GROUP BY trading_date, strike`)
      .all(...cappedDates) as { date: string; strike: number; volume: number | null }[];
    return putRows.filter((row) => row.strike <= capByDate.get(row.date)! + 1e-9).reduce((sum, row) => sum + (row.volume ?? 0), 0);
  });
}

/** The recent and year averages from each day's Call and Put volume; `cappedPutVolumeOf` sums the Puts under each date's cap. */
function volumeSummaryOf(byDate: ReadonlyMap<string, { calls: number; puts: number }>, capByDate: ReadonlyMap<string, number>, cappedPutVolumeOf: (cappedDates: string[]) => number): AnalysisOptionActivity["volume"] {
  const dates = [...byDate.keys()].sort().reverse().slice(0, optionVolumeYearSessions);
  if (dates.length === 0) return null;
  const recent = dates.slice(0, optionVolumeRecentSessions);
  const total = (date: string) => byDate.get(date)!.calls + byDate.get(date)!.puts;
  const recentCalls = recent.reduce((sum, date) => sum + byDate.get(date)!.calls, 0);
  const recentTotal = recent.reduce((sum, date) => sum + total(date), 0);

  const cappedDates = recent.filter((date) => capByDate.has(date));
  const cappedPutsAveragePerDay = cappedDates.length > 0 ? cappedPutVolumeOf(cappedDates) / cappedDates.length : null;
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

/** A schema 4 day's end-of-day contracts, every expiry: strike, right and volume, or the open interest. */
function sliceContractsOfDay(database: DatabaseSync, table: "end_of_day_slices" | "open_interest_slices", dayNumber: number): { strike: number; right: "C" | "P"; value: number | null }[] {
  const kinds = table === "end_of_day_slices" ? endOfDayColumns : openInterestColumns;
  const valueColumn = table === "end_of_day_slices" ? sliceColumn.volume : sliceColumn.openInterest;
  const contracts: { strike: number; right: "C" | "P"; value: number | null }[] = [];
  for (const { data } of database.prepare(`SELECT data FROM ${table} WHERE key BETWEEN ? AND ? ORDER BY key`).all(sliceKey(dayNumber, dailySliceLookMinute, 0), sliceKey(dayNumber, dailySliceLookMinute, 65_535)) as { data: Uint8Array }[]) {
    const slice = decodeSlice(data, kinds);
    for (let index = 0; index < slice.count; index++) contracts.push({ strike: slice.columns[sliceColumn.strike]!.values[index]!, right: slice.puts[index] === 1 ? "P" : "C", value: sliceValueAt(slice.columns[valueColumn]!, index) });
  }
  return contracts;
}

/** The latest days (up to a year's sessions) with end-of-day rows up to `lastDate`, with their Call and Put volume (volumeOf's figures). */
function sliceVolumeByDate(database: DatabaseSync, lastDate: string): Map<string, { calls: number; puts: number }> {
  const dayNumbers = (database.prepare("SELECT DISTINCT key / 4294967296 AS dayNumber FROM end_of_day_slices WHERE key < ? ORDER BY dayNumber DESC LIMIT ?").all(sliceKey(dayNumberOf(lastDate) + 1, 0, 0), optionVolumeYearSessions) as { dayNumber: number }[]).map((row) => row.dayNumber);
  const byDate = new Map<string, { calls: number; puts: number }>();
  for (const dayNumber of dayNumbers) {
    const day = { calls: 0, puts: 0 };
    for (const contract of sliceContractsOfDay(database, "end_of_day_slices", dayNumber)) {
      if (contract.right === "C") day.calls += contract.value ?? 0;
      else day.puts += contract.value ?? 0;
    }
    byDate.set(isoDateOfDayNumber(dayNumber), day);
  }
  return byDate;
}

function slicePutVolumeUnderCaps(database: DatabaseSync, cappedDates: string[], capByDate: ReadonlyMap<string, number>): number {
  let volume = 0;
  for (const date of cappedDates) for (const contract of sliceContractsOfDay(database, "end_of_day_slices", dayNumberOf(date))) if (contract.right === "P" && contract.strike <= capByDate.get(date)! + 1e-9) volume += contract.value ?? 0;
  return volume;
}

function sliceOpenInterestOf(database: DatabaseSync, lastDate: string, capByDate: ReadonlyMap<string, number>): AnalysisOptionActivity["openInterest"] {
  const latestKey = (database.prepare("SELECT max(key) AS key FROM open_interest_slices WHERE key < ?").get(sliceKey(dayNumberOf(lastDate) + 1, 0, 0)) as { key: number | null }).key;
  if (latestKey === null) return null;
  const latest = isoDateOfDayNumber(dayNumberOfKey(latestKey));
  const contracts = sliceContractsOfDay(database, "open_interest_slices", dayNumberOfKey(latestKey));
  const calls = contracts.filter((contract) => contract.right === "C").reduce((sum, contract) => sum + (contract.value ?? 0), 0);
  const puts = contracts.filter((contract) => contract.right !== "C").reduce((sum, contract) => sum + (contract.value ?? 0), 0);
  const cap = capByDate.get(latest);
  return {
    date: latest,
    total: calls + puts,
    callShare: calls + puts > 0 ? calls / (calls + puts) : null,
    cappedPuts: cap === undefined ? null : contracts.filter((contract) => contract.right !== "C" && contract.strike <= cap + 1e-9).reduce((sum, contract) => sum + (contract.value ?? 0), 0),
  };
}
