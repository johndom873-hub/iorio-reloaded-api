import type { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { dayDataTransferList, type DayDataPayload, type DayDataReaderReply, type DayDataReaderRequest } from "./backtestDayDataReader.js";
import { dayDataEndOfDayValueColumns, dayDataIntradayValueColumns, dayDataQuoteValueColumns, dayDataTableOfSlices, DayDataStrings, SymbolFileSliceReads, type StoredSlice } from "./symbolFileSliceReads.js";
import { endOfDayColumns, intradayQuoteColumns, tenOClockQuoteColumns } from "./symbolFileSlices.js";

// The day-data reader thread of a session (backtestDayDataReader.ts): reads a symbol's day from the file's slices as
// BacktestSymbolFile does (symbolFileSliceReads.ts) and sends the rows back as columns.

if (!parentPort) throw new Error("backtestDayDataReaderWorker.ts runs as the day-data reader thread of a backtest session.");
const port = parentPort;

interface OpenedFile {
  database: DatabaseSync;
  slices: SymbolFileSliceReads;
}

const openedFiles = new Map<string, OpenedFile>();

function fileOf(symbol: string): OpenedFile {
  let opened = openedFiles.get(symbol);
  if (!opened) {
    const database = openBacktestDataFileReadOnly(symbol);
    if (!database) throw new Error(`No data file for ${symbol}.`);
    database.exec("PRAGMA busy_timeout = 3000");
    opened = { database, slices: new SymbolFileSliceReads(database) };
    openedFiles.set(symbol, opened);
  }
  return opened;
}

function readDay(request: DayDataReaderRequest): DayDataPayload {
  const { slices } = fileOf(request.symbol);
  const strings = new DayDataStrings();
  const quotesOf = (stored: StoredSlice[]) => dayDataTableOfSlices(stored, tenOClockQuoteColumns, dayDataQuoteValueColumns, strings, false);
  const endOfDayOf = (stored: StoredSlice[]) => dayDataTableOfSlices(stored, endOfDayColumns, dayDataEndOfDayValueColumns, strings, false);
  let nextCallExpiryDay: DayDataPayload["nextCallExpiryDay"] = null;
  if (request.readsNextCallExpiryOnly) {
    const { quoteSlice, previousEndOfDaySlice, ...parts } = slices.nextCallExpiryParts(request.tradingDate, request.previousFileDay);
    nextCallExpiryDay = { ...parts, quotes: quotesOf(quoteSlice === null ? [] : [quoteSlice]), previousEndOfDay: endOfDayOf(previousEndOfDaySlice === null ? [] : [previousEndOfDaySlice]) };
  }
  const check = request.intradayLookCheck;
  return {
    strings: strings.strings,
    quotes: request.readsNextCallExpiryOnly ? null : quotesOf(slices.tenOClockSlicesOf(request.tradingDate)),
    endOfDay: request.readsNextCallExpiryOnly ? null : endOfDayOf(slices.endOfDaySlicesOf(request.tradingDate)),
    nextCallExpiryDay,
    intraday: request.readsIntradayQuotes ? dayDataTableOfSlices(slices.intradaySlicesAfter(request.tradingDate, request.intradayAfterLookTime), intradayQuoteColumns, dayDataIntradayValueColumns, strings, true) : null,
    intradayAfterLookTime: request.intradayAfterLookTime,
    intradayLookCheck: check ? { ...check, hasQuote: slices.hasIntradayQuoteWithin(request.tradingDate, check.lookTime, check.lowestStrike, check.highestStrike) } : null,
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
