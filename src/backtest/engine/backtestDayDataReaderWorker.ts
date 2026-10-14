import type { DatabaseSync, StatementSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { dayDataTransferList, type DayDataColumn, type DayDataPayload, type DayDataReaderReply, type DayDataReaderRequest, type DayDataTable } from "./backtestDayDataReader.js";
import { endOfDayOfDaySql, expiresWithin45DaysSql, intradayQuotesColumnsSql, numberOrNull, openInterestOfDaySql, quotesOfDaySql } from "./backtestSymbolFile.js";

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
  intraday: StatementSync | null;
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
    const intraday = tableNames.has("intraday_days") && tableNames.has("intraday_quotes") ? database.prepare(`${intradayQuotesColumnsSql} WHERE trading_date = ? AND look_time > ? AND ${expiresWithin45DaysSql}`) : null;
    intraday?.setReturnArrays(true);
    opened = { database, quotes: statements[0], endOfDay: statements[1], openInterest: statements[2], intraday };
    openedFiles.set(symbol, opened);
  }
  return opened;
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
    intraday: file.intraday ? encodeTable(all(file.intraday, request.tradingDate, request.intradayAfterLookTime), ["string", "string", "number", "string", "nullableNumber", "nullableNumber"], strings, stringIndex) : null,
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
