import type { DatabaseSync } from "node:sqlite";
import { dailySliceLookMinute, dayNumberOf, dayNumberOfKey, decodeSlice, endOfDayColumns, isoDateOfDayNumber, openInterestColumns, sliceColumn, sliceKey, sliceValueAt } from "../engine/symbolFileSlices.js";

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

/** Volume and open interest up to `lastDate`; `capByDate` holds each scanned day's first-rung cap. */
export function computeOptionActivity(database: DatabaseSync, lastDate: string, capByDate: ReadonlyMap<string, number>): AnalysisOptionActivity {
  return { volume: volumeOf(database, lastDate, capByDate), openInterest: openInterestOf(database, lastDate, capByDate) };
}

/** A day's contracts of every expiry from its end-of-day or open-interest slices: strike, right and the volume or the open interest. */
function contractsOfDay(database: DatabaseSync, table: "end_of_day_slices" | "open_interest_slices", dayNumber: number): { strike: number; right: "C" | "P"; value: number | null }[] {
  const kinds = table === "end_of_day_slices" ? endOfDayColumns : openInterestColumns;
  const valueColumn = table === "end_of_day_slices" ? sliceColumn.volume : sliceColumn.openInterest;
  const contracts: { strike: number; right: "C" | "P"; value: number | null }[] = [];
  for (const { data } of database.prepare(`SELECT data FROM ${table} WHERE key BETWEEN ? AND ? ORDER BY key`).all(sliceKey(dayNumber, dailySliceLookMinute, 0), sliceKey(dayNumber, dailySliceLookMinute, 65_535)) as { data: Uint8Array }[]) {
    const slice = decodeSlice(data, kinds);
    for (let index = 0; index < slice.count; index++) contracts.push({ strike: slice.columns[sliceColumn.strike]!.values[index]!, right: slice.puts[index] === 1 ? "P" : "C", value: sliceValueAt(slice.columns[valueColumn]!, index) });
  }
  return contracts;
}

function volumeOf(database: DatabaseSync, lastDate: string, capByDate: ReadonlyMap<string, number>): AnalysisOptionActivity["volume"] {
  // The latest days with end-of-day rows up to `lastDate`, a year's sessions at most.
  const dayNumbers = (database.prepare("SELECT DISTINCT key / 4294967296 AS dayNumber FROM end_of_day_slices WHERE key < ? ORDER BY dayNumber DESC LIMIT ?").all(sliceKey(dayNumberOf(lastDate) + 1, 0, 0), optionVolumeYearSessions) as { dayNumber: number }[]).map((row) => row.dayNumber);
  const byDate = new Map<string, { calls: number; puts: number }>();
  for (const dayNumber of dayNumbers) {
    const day = { calls: 0, puts: 0 };
    for (const contract of contractsOfDay(database, "end_of_day_slices", dayNumber)) {
      if (contract.right === "C") day.calls += contract.value ?? 0;
      else day.puts += contract.value ?? 0;
    }
    byDate.set(isoDateOfDayNumber(dayNumber), day);
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
    let capped = 0;
    for (const date of cappedDates) for (const contract of contractsOfDay(database, "end_of_day_slices", dayNumberOf(date))) if (contract.right === "P" && contract.strike <= capByDate.get(date)! + 1e-9) capped += contract.value ?? 0;
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
  const latestKey = (database.prepare("SELECT max(key) AS key FROM open_interest_slices WHERE key < ?").get(sliceKey(dayNumberOf(lastDate) + 1, 0, 0)) as { key: number | null }).key;
  if (latestKey === null) return null;
  const latest = isoDateOfDayNumber(dayNumberOfKey(latestKey));
  const contracts = contractsOfDay(database, "open_interest_slices", dayNumberOfKey(latestKey));
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
