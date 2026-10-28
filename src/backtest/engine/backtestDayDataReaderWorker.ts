import type { DatabaseSync, StatementSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import { addCalendarDays } from "../../lib/calendarDays.js";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { dayDataTransferList, type DayDataColumn, type DayDataPayload, type DayDataReaderReply, type DayDataReaderRequest, type DayDataTable, type StrikeRange } from "./backtestDayDataReader.js";
import { endOfDayOfDaySql, intradayQuotesColumnsSql, numberOrNull, openInterestOfDaySql, quotesOfDaySql } from "./backtestSymbolFile.js";

// The day-data reader thread of a session (backtestDayDataReader.ts): reads a symbol's day with BacktestSymbolFile's
// statements, applies the same conversions, and sends the rows back as columns. A value a column cannot carry exactly
// (a string where a number belongs, or the reverse) fails the day, which the session then reads from the file.

if (!parentPort) throw new Error("backtestDayDataReaderWorker.ts runs as the day-data reader thread of a backtest session.");
const port = parentPort;

interface OpenedFile {
  database: DatabaseSync;
  quotes: StatementSync;
  endOfDay: StatementSync;
  openInterest: StatementSync;
  /** A day's next look time after the one given (null after the last), one look's rows expiring by a date, and a strike of one of them in a range. */
  intraday: { nextLookTime: StatementSync; rowsOfLook: StatementSync; strikeOfLookWithin: StatementSync } | null;
}

const openedFiles = new Map<string, OpenedFile>();

function fileOf(symbol: string): OpenedFile {
  let opened = openedFiles.get(symbol);
  if (!opened) {
    const database = openBacktestDataFileReadOnly(symbol);
    if (!database) throw new Error(`No data file for ${symbol}.`);
    database.exec("PRAGMA busy_timeout = 3000");
    const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    const statements = [database.prepare(quotesOfDaySql), database.prepare(endOfDayOfDaySql), database.prepare(openInterestOfDaySql)] as const;
    for (const statement of statements) statement.setReturnArrays(true);
    // One look at a time, so the expiry bounds the primary key's range (the file keeps every expiry of every look).
    const intraday =
      tableNames.has("intraday_days") && tableNames.has("intraday_quotes")
        ? {
            nextLookTime: database.prepare("SELECT min(look_time) AS lookTime FROM intraday_quotes WHERE trading_date = ? AND look_time > ?"),
            rowsOfLook: database.prepare(`${intradayQuotesColumnsSql} WHERE trading_date = ? AND look_time = ? AND expiry <= ?`),
            strikeOfLookWithin: database.prepare("SELECT strike FROM intraday_quotes WHERE trading_date = ? AND look_time = ? AND expiry <= ? AND strike BETWEEN ? AND ? LIMIT 1"),
          }
        : null;
    intraday?.rowsOfLook.setReturnArrays(true);
    opened = { database, quotes: statements[0], endOfDay: statements[1], openInterest: statements[2], intraday };
    openedFiles.set(symbol, opened);
  }
  return opened;
}

/**
 * A day's intraday rows after a look time with an expiry within 45 days (expiresWithin45DaysSql), in primary-key order:
 * the rows of each look in turn.
 */
function intradayRowsAfter(intraday: NonNullable<OpenedFile["intraday"]>, tradingDate: string, afterLookTime: string): unknown[][] {
  const lastExpiry = addCalendarDays(tradingDate, 45);
  const rows: unknown[][] = [];
  for (const lookTime of lookTimesAfter(intraday, tradingDate, afterLookTime)) for (const row of intraday.rowsOfLook.all(tradingDate, lookTime, lastExpiry) as unknown as unknown[][]) rows.push(row);
  return rows;
}

/** The same looks probed for one of those rows with a strike in the range (PrefetchedSymbolDay.intradayLookHasStrikeWithin). */
function intradayProbesAfter(intraday: NonNullable<OpenedFile["intraday"]>, tradingDate: string, afterLookTime: string, range: StrikeRange | null): { lookTime: string; strikeWithinRange: number | null }[] {
  const lastExpiry = addCalendarDays(tradingDate, 45);
  return lookTimesAfter(intraday, tradingDate, afterLookTime).map((lookTime) => {
    const found = range === null ? undefined : (intraday.strikeOfLookWithin.get(tradingDate, lookTime, lastExpiry, range.lowestStrike, range.highestStrike) as { strike: number } | undefined);
    return { lookTime, strikeWithinRange: found === undefined ? null : Number(found.strike) };
  });
}

/** The day's look times after the one given, ascending. */
function lookTimesAfter(intraday: NonNullable<OpenedFile["intraday"]>, tradingDate: string, afterLookTime: string): string[] {
  const lookTimes: string[] = [];
  const nextLookTime = (lookTime: string) => (intraday.nextLookTime.get(tradingDate, lookTime) as { lookTime: string | null }).lookTime;
  for (let lookTime = nextLookTime(afterLookTime); lookTime !== null; lookTime = nextLookTime(lookTime)) lookTimes.push(lookTime);
  return lookTimes;
}

type CellKind = "string" | "number" | "nullableNumber";

/** Encodes rows (already converted) into columns of the given kinds, sharing one string table. */
function encodeTable(rows: readonly unknown[][], kinds: readonly CellKind[], strings: string[], stringIndex: Map<string, number>): DayDataTable {
  const columns: DayDataColumn[] = kinds.map((kind, columnIndex) => {
    if (kind === "string") {
      const indices = new Int32Array(rows.length);
      rows.forEach((row, rowIndex) => {
        const value = row[columnIndex];
        if (typeof value !== "string") throw new Error(`column ${columnIndex}: ${typeof value} where a string belongs`);
        let index = stringIndex.get(value);
        if (index === undefined) {
          index = strings.length;
          strings.push(value);
          stringIndex.set(value, index);
        }
        indices[rowIndex] = index;
      });
      return { kind, indices };
    }
    const values = new Float64Array(rows.length);
    const nulls = new Uint8Array(rows.length);
    rows.forEach((row, rowIndex) => {
      const value = row[columnIndex];
      if (value === null && kind === "nullableNumber") nulls[rowIndex] = 1;
      else if (typeof value === "number") values[rowIndex] = value;
      else throw new Error(`column ${columnIndex}: ${value === null ? "null" : typeof value} where a number belongs`);
    });
    return { kind: "number", values, nulls };
  });
  return { rowCount: rows.length, columns };
}

function readDay(request: DayDataReaderRequest): DayDataPayload {
  const file = fileOf(request.symbol);
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const all = (statement: StatementSync, ...parameters: string[]) => statement.all(...parameters) as unknown as unknown[][];
  // The conversions of BacktestSymbolFile.loadQuotes, loadEndOfDay and loadOpenInterest; intraday rows are taken as stored.
  const quotes = all(file.quotes, request.tradingDate).map(([expiry, strike, right, bid, ask, bidSize, askSize]) => [String(expiry), Number(strike), right, numberOrNull(bid), numberOrNull(ask), numberOrNull(bidSize), numberOrNull(askSize)]);
  const endOfDay = all(file.endOfDay, request.tradingDate).map(([expiry, strike, right, close, volume, bid, ask]) => [String(expiry), Number(strike), right, numberOrNull(close), numberOrNull(volume), numberOrNull(bid), numberOrNull(ask)]);
  const openInterest = all(file.openInterest, request.tradingDate).map(([expiry, strike, right, interest]) => [String(expiry), Number(strike), right, Number(interest)]);
  return {
    strings,
    quotes: encodeTable(quotes, ["string", "number", "string", "nullableNumber", "nullableNumber", "nullableNumber", "nullableNumber"], strings, stringIndex),
    endOfDay: encodeTable(endOfDay, ["string", "number", "string", "nullableNumber", "nullableNumber", "nullableNumber", "nullableNumber"], strings, stringIndex),
    openInterest: encodeTable(openInterest, ["string", "number", "string", "number"], strings, stringIndex),
    intraday: file.intraday && !request.probeIntradayQuotesOnly ? encodeTable(intradayRowsAfter(file.intraday, request.tradingDate, request.intradayAfterLookTime), ["string", "string", "number", "string", "nullableNumber", "nullableNumber"], strings, stringIndex) : null,
    intradayProbes: file.intraday && request.probeIntradayQuotesOnly ? intradayProbesAfter(file.intraday, request.tradingDate, request.intradayAfterLookTime, request.probeStrikeRange) : null,
    intradayAfterLookTime: request.intradayAfterLookTime,
  };
}

port.on("message", (request: DayDataReaderRequest) => {
  let reply: DayDataReaderReply;
  try {
    const payload = readDay(request);
    reply = { id: request.id, ok: true, payload };
    port.postMessage(reply, dayDataTransferList(payload));
  } catch (error) {
    reply = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    port.postMessage(reply);
  }
});
