import type { DatabaseSync, StatementSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import { addCalendarDays } from "../../lib/calendarDays.js";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { dayDataTransferList, type DayDataColumn, type DayDataPayload, type DayDataReaderReply, type DayDataReaderRequest, type DayDataTable } from "./backtestDayDataReader.js";
import { endOfDayOfDaySql, endOfDayOfExpirySql, endOfDayWithVolumeSql, intradayQuotesColumnsSql, intradayQuoteWithinSql, nextCallExpirySql, nextIntradayLookTimeSql, numberOrNull, quoteCountByRightOf, quoteCountByRightSql, quotesOfDaySql, quotesOfExpirySql, quoteWithAskAboveZeroSql } from "./backtestSymbolFile.js";

// The day-data reader thread of a session (backtestDayDataReader.ts): reads a symbol's day with BacktestSymbolFile's
// statements, applies the same conversions, and sends the rows back as columns. A value a column cannot carry exactly
// (a string where a number belongs, or the reverse) fails the day, which the session then reads from the file.

if (!parentPort) throw new Error("backtestDayDataReaderWorker.ts runs as the day-data reader thread of a backtest session.");
const port = parentPort;

interface OpenedFile {
  database: DatabaseSync;
  quotes: StatementSync;
  endOfDay: StatementSync;
  /** Vol Farmer v2's day (NextCallExpiryDay). */
  nextCallExpiry: { expiry: StatementSync; quotesOfExpiry: StatementSync; quoteCountByRight: StatementSync; quoteWithAskAboveZero: StatementSync; endOfDayOfExpiry: StatementSync; endOfDayWithVolume: StatementSync };
  /** A day's next look time after the one given (null after the last), one look's rows expiring by a date, and whether a look has a quote in a strike range. */
  intraday: { nextLookTime: StatementSync; rowsOfLook: StatementSync; quoteWithin: StatementSync } | null;
}

const openedFiles = new Map<string, OpenedFile>();

function fileOf(symbol: string): OpenedFile {
  let opened = openedFiles.get(symbol);
  if (!opened) {
    const database = openBacktestDataFileReadOnly(symbol);
    if (!database) throw new Error(`No data file for ${symbol}.`);
    database.exec("PRAGMA busy_timeout = 3000");
    const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    const statements = [database.prepare(quotesOfDaySql), database.prepare(endOfDayOfDaySql), database.prepare(quotesOfExpirySql), database.prepare(endOfDayOfExpirySql)] as const;
    for (const statement of statements) statement.setReturnArrays(true);
    const nextCallExpiry = { expiry: database.prepare(nextCallExpirySql), quotesOfExpiry: statements[2], quoteCountByRight: database.prepare(quoteCountByRightSql), quoteWithAskAboveZero: database.prepare(quoteWithAskAboveZeroSql), endOfDayOfExpiry: statements[3], endOfDayWithVolume: database.prepare(endOfDayWithVolumeSql) };
    // One look at a time, so the expiry bounds the primary key's range (the file keeps every expiry of every look).
    const intraday =
      tableNames.has("intraday_days") && tableNames.has("intraday_quotes")
        ? { nextLookTime: database.prepare(nextIntradayLookTimeSql), rowsOfLook: database.prepare(`${intradayQuotesColumnsSql} WHERE trading_date = ? AND look_time = ? AND expiry <= ?`), quoteWithin: database.prepare(intradayQuoteWithinSql) }
        : null;
    intraday?.rowsOfLook.setReturnArrays(true);
    opened = { database, quotes: statements[0], endOfDay: statements[1], nextCallExpiry, intraday };
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

const quoteKinds: readonly CellKind[] = ["string", "number", "string", "nullableNumber", "nullableNumber", "nullableNumber", "nullableNumber"];
const endOfDayKinds: readonly CellKind[] = ["string", "number", "string", "nullableNumber", "nullableNumber", "nullableNumber", "nullableNumber"];

function readDay(request: DayDataReaderRequest): DayDataPayload {
  const file = fileOf(request.symbol);
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const all = (statement: StatementSync, ...parameters: string[]) => statement.all(...parameters) as unknown as unknown[][];
  // The conversions of BacktestSymbolFile.loadQuotes and loadEndOfDay; intraday rows are taken as stored.
  const quotesOf = (rows: unknown[][]) => encodeTable(rows.map(([expiry, strike, right, bid, ask, bidSize, askSize]) => [String(expiry), Number(strike), right, numberOrNull(bid), numberOrNull(ask), numberOrNull(bidSize), numberOrNull(askSize)]), quoteKinds, strings, stringIndex);
  const endOfDayOf = (rows: unknown[][]) => encodeTable(rows.map(([expiry, strike, right, close, volume, bid, ask]) => [String(expiry), Number(strike), right, numberOrNull(close), numberOrNull(volume), numberOrNull(bid), numberOrNull(ask)]), endOfDayKinds, strings, stringIndex);
  // BacktestSymbolFile.loadNextCallExpiryDay's statements, in its order.
  const nextCallExpiryDay = (): DayDataPayload["nextCallExpiryDay"] => {
    const { tradingDate, previousFileDay } = request;
    const statements = file.nextCallExpiry;
    const expiry = (statements.expiry.get(tradingDate, tradingDate, tradingDate) as { expiry: string | null }).expiry;
    return {
      expiry,
      quotes: quotesOf(expiry === null ? [] : all(statements.quotesOfExpiry, tradingDate, expiry)),
      quoteCountByRight: quoteCountByRightOf(statements.quoteCountByRight.all(tradingDate) as { right: string; count: number }[]),
      hasAskAboveZero: statements.quoteWithAskAboveZero.get(tradingDate) !== undefined,
      previousEndOfDay: endOfDayOf(previousFileDay === null || expiry === null ? [] : all(statements.endOfDayOfExpiry, previousFileDay, expiry)),
      previousHasVolume: previousFileDay === null ? null : statements.endOfDayWithVolume.get(previousFileDay) !== undefined,
    };
  };
  return {
    strings,
    quotes: request.readsNextCallExpiryOnly ? null : quotesOf(all(file.quotes, request.tradingDate)),
    endOfDay: request.readsNextCallExpiryOnly ? null : endOfDayOf(all(file.endOfDay, request.tradingDate)),
    nextCallExpiryDay: request.readsNextCallExpiryOnly ? nextCallExpiryDay() : null,
    intraday: file.intraday && request.readsIntradayQuotes ? encodeTable(intradayRowsAfter(file.intraday, request.tradingDate, request.intradayAfterLookTime), ["string", "string", "number", "string", "nullableNumber", "nullableNumber"], strings, stringIndex) : null,
    intradayAfterLookTime: request.intradayAfterLookTime,
    intradayLookCheck:
      file.intraday && request.intradayLookCheck
        ? { ...request.intradayLookCheck, hasQuote: file.intraday.quoteWithin.get(request.tradingDate, request.intradayLookCheck.lookTime, request.intradayLookCheck.lowestStrike, request.intradayLookCheck.highestStrike) !== undefined }
        : null,
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
