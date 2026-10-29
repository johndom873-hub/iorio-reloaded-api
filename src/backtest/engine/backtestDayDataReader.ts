import { Worker } from "node:worker_threads";
import { engineWorkerExecArgv, engineWorkerModuleUrl } from "./engineWorkerThreads.js";
import type { NextCallExpiryDay, SymbolFileEndOfDayRow, SymbolFileQuote } from "./backtestSymbolFile.js";

// Reading the symbol files ahead of the session (Marcelo 2026-10-12): a day's 10:00 quotes, end-of-day rows and
// intraday quotes are read on threads of their own, a few days before the session reaches them, from the file's slices
// as BacktestSymbolFile reads them (backtestDayDataReaderWorker.ts). They come back as columns in transferred buffers,
// and the session's thread only builds the rows from them, in the order and with the values the file would have given.
// A day a thread could not read is read from the file as before.

export type DayDataColumn = { kind: "string"; indices: Int32Array } | { kind: "number"; values: Float64Array; nulls: Uint8Array };

export interface DayDataTable {
  rowCount: number;
  columns: DayDataColumn[];
}

/** A look checked for an intraday quote with a strike from `lowestStrike` to `highestStrike` (BacktestSymbolFile.hasIntradayQuoteWithin). */
export interface IntradayLookCheck {
  lookTime: string;
  lowestStrike: number;
  highestStrike: number;
}

/** What a day's request asks of the reader threads besides its rows. */
export interface DayDataRequestExtras {
  /** A look to check for a quote in a strike range while the day is read (PrefetchedSymbolDay.intradayLookHasQuoteWithin); null for none. */
  intradayLookCheck: IntradayLookCheck | null;
  /** The file day before the day (null on the first), read with it when the threads read Vol Farmer v2's days. */
  previousFileDay: string | null;
}

/** One symbol's day as the reader thread sends it. */
export interface DayDataPayload {
  strings: string[];
  /** Every 10:00 quote of the day within 45 days, and every end-of-day row within 46; null when the threads read Vol Farmer v2's day instead. */
  quotes: DayDataTable | null;
  endOfDay: DayDataTable | null;
  /** NextCallExpiryDay, its rows as columns; null when the threads read the day in full. */
  nextCallExpiryDay: (Omit<NextCallExpiryDay, "quotes" | "previousEndOfDay"> & { quotes: DayDataTable; previousEndOfDay: DayDataTable }) | null;
  /** Every intraday row of the day after `intradayAfterLookTime`, look by look in the file's order; null when the session does not read them. */
  intraday: DayDataTable | null;
  intradayAfterLookTime: string;
  /** The request's look check with its answer; null when it asked none. */
  intradayLookCheck: (IntradayLookCheck & { hasQuote: boolean }) | null;
}

export type DayDataReaderRequest = { id: number; symbol: string; tradingDate: string; intradayAfterLookTime: string; readsIntradayQuotes: boolean; readsNextCallExpiryOnly: boolean } & DayDataRequestExtras;
export type DayDataReaderReply = { id: number; ok: true; payload: DayDataPayload } | { id: number; ok: false; error: string };

/** The buffers of a payload, to transfer rather than copy. */
export function dayDataTransferList(payload: DayDataPayload): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const table of [payload.quotes, payload.endOfDay, payload.nextCallExpiryDay?.quotes, payload.nextCallExpiryDay?.previousEndOfDay, payload.intraday]) {
    for (const column of table?.columns ?? []) {
      if (column.kind === "string") buffers.push(column.indices.buffer as ArrayBuffer);
      else buffers.push(column.values.buffer as ArrayBuffer, column.nulls.buffer as ArrayBuffer);
    }
  }
  return buffers;
}

/** Reads a column's value at a row: a string, a number, or null. */
function cellReader(strings: readonly string[], column: DayDataColumn): (row: number) => string | number | null {
  if (column.kind === "string") return (row) => strings[column.indices[row]!]!;
  return (row) => (column.nulls[row] === 1 ? null : column.values[row]!);
}

/** The quote rows of a table, as BacktestSymbolFile builds them. */
function quoteRowsOf(strings: readonly string[], table: DayDataTable): SymbolFileQuote[] {
  const [expiry, strike, right, bid, ask, bidSize, askSize] = table.columns.map((column) => cellReader(strings, column));
  const rows: SymbolFileQuote[] = new Array(table.rowCount);
  for (let row = 0; row < table.rowCount; row++) rows[row] = { expiry: expiry!(row) as string, strike: strike!(row) as number, right: right!(row) as "C" | "P", bid: bid!(row) as number | null, ask: ask!(row) as number | null, bidSize: bidSize!(row) as number | null, askSize: askSize!(row) as number | null };
  return rows;
}

/** The end-of-day rows of a table, as BacktestSymbolFile builds them. */
function endOfDayRowsOf(strings: readonly string[], table: DayDataTable): SymbolFileEndOfDayRow[] {
  const [expiry, strike, right, close, volume, bid, ask] = table.columns.map((column) => cellReader(strings, column));
  const rows: SymbolFileEndOfDayRow[] = new Array(table.rowCount);
  for (let row = 0; row < table.rowCount; row++) rows[row] = { expiry: expiry!(row) as string, strike: strike!(row) as number, right: right!(row) as "C" | "P", close: close!(row) as number | null, volume: volume!(row) as number | null, bid: bid!(row) as number | null, ask: ask!(row) as number | null };
  return rows;
}

/** One symbol's day read ahead: each part built when first asked for, as BacktestSymbolFile builds it. */
export class PrefetchedSymbolDay {
  constructor(private readonly payload: DayDataPayload) {}

  /** BacktestSymbolFile.loadQuotes; null when the day was read for Vol Farmer v2 (the caller reads the file then). */
  quotes(): SymbolFileQuote[] | null {
    return this.payload.quotes === null ? null : quoteRowsOf(this.payload.strings, this.payload.quotes);
  }

  /** BacktestSymbolFile.loadEndOfDay; null when the day was read for Vol Farmer v2 (the caller reads the file then). */
  endOfDay(): SymbolFileEndOfDayRow[] | null {
    return this.payload.endOfDay === null ? null : endOfDayRowsOf(this.payload.strings, this.payload.endOfDay);
  }

  /** BacktestSymbolFile.loadNextCallExpiryDay; null when the day was read in full (the caller reads the file then). */
  nextCallExpiryDay(): NextCallExpiryDay | null {
    const day = this.payload.nextCallExpiryDay;
    if (day === null) return null;
    return { expiry: day.expiry, quotes: quoteRowsOf(this.payload.strings, day.quotes), quoteCountByRight: day.quoteCountByRight, hasAskAboveZero: day.hasAskAboveZero, previousEndOfDay: endOfDayRowsOf(this.payload.strings, day.previousEndOfDay), previousHasVolume: day.previousHasVolume };
  }

  /**
   * BacktestSymbolFile.loadIntradayQuotes: the rows after `afterLookTime` through `throughLookTime` with a strike from
   * `lowestStrike` to `highestStrike` (the same comparisons, on the same strings and numbers), in the file's order. Null
   * when the day was read after another look time or without its intraday rows: the caller reads the file then.
   */
  intradayQuotes(afterLookTime: string, throughLookTime: string, lowestStrike: number, highestStrike: number): Map<string, SymbolFileQuote[]> | null {
    const table = this.payload.intraday;
    if (table === null || afterLookTime !== this.payload.intradayAfterLookTime) return null;
    const [lookTime, expiry, strike, right, bid, ask] = table.columns.map((column) => cellReader(this.payload.strings, column));
    const quotesByLookTime = new Map<string, SymbolFileQuote[]>();
    for (let row = 0; row < table.rowCount; row++) {
      const rowLookTime = lookTime!(row) as string;
      const rowStrike = strike!(row) as number;
      if (!(rowLookTime <= throughLookTime) || !(rowStrike >= lowestStrike && rowStrike <= highestStrike)) continue;
      let quotes = quotesByLookTime.get(rowLookTime);
      if (!quotes) quotesByLookTime.set(rowLookTime, (quotes = []));
      quotes.push({ expiry: expiry!(row) as string, strike: rowStrike, right: right!(row) as "C" | "P", bid: bid!(row) as number | null, ask: ask!(row) as number | null, bidSize: null, askSize: null });
    }
    return quotesByLookTime;
  }

  /**
   * True when the thread's look check tells that hasIntradayQuoteWithin(lookTime, lowestStrike, highestStrike) holds: it
   * found a quote at this look within a range inside this one. Null otherwise: the caller asks the file.
   */
  intradayLookHasQuoteWithin(lookTime: string, lowestStrike: number, highestStrike: number): true | null {
    const check = this.payload.intradayLookCheck;
    return check !== null && check.hasQuote && check.lookTime === lookTime && check.lowestStrike >= lowestStrike && check.highestStrike <= highestStrike ? true : null;
  }
}

/**
 * The reader threads of one session, each with its own connection to the files. prefetch() queues a symbol's day;
 * take() hands it over once read (null when it could not be: the caller reads the file). Without `readsIntradayQuotes`
 * (a session whose looks after 10:00 only mark what it holds, reading the held contracts by their key) the threads leave
 * the intraday rows alone; with `readsNextCallExpiryOnly` (Vol Farmer v2) they read its NextCallExpiryDay in place of
 * the day's 10:00 quotes and end-of-day rows.
 */
export class BacktestDayDataReader {
  private readonly workers: Worker[];
  private nextWorkerIndex = 0;
  private readonly pending = new Map<number, (reply: DayDataReaderReply | null) => void>();
  private readonly requested = new Map<string, Promise<PrefetchedSymbolDay | null>>();
  private nextRequestId = 1;
  private stopped = false;

  constructor(private readonly options: { readsIntradayQuotes: boolean; readsNextCallExpiryOnly: boolean; threadCount: number }) {
    const stop = () => {
      this.stopped = true;
      for (const resolve of this.pending.values()) resolve(null);
      this.pending.clear();
    };
    this.workers = Array.from({ length: options.threadCount }, () => {
      const worker = new Worker(engineWorkerModuleUrl("backtestDayDataReaderWorker"), { execArgv: engineWorkerExecArgv() });
      worker.on("message", (reply: DayDataReaderReply) => {
        const resolve = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        resolve?.(reply);
      });
      worker.on("error", stop);
      worker.on("exit", stop);
      return worker;
    });
  }

  /** Queues the day on the threads in turn, so the days asked for ahead are read at the same time. */
  prefetch(symbol: string, tradingDate: string, intradayAfterLookTime: string, extras: DayDataRequestExtras = { intradayLookCheck: null, previousFileDay: null }): void {
    const key = `${symbol}|${tradingDate}|${intradayAfterLookTime}`;
    if (this.requested.has(key)) return;
    const read = new Promise<DayDataReaderReply | null>((resolve) => {
      if (this.stopped) return resolve(null);
      const id = this.nextRequestId++;
      this.pending.set(id, resolve);
      const worker = this.workers[this.nextWorkerIndex]!;
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
      worker.postMessage({ id, symbol, tradingDate, intradayAfterLookTime, readsIntradayQuotes: this.options.readsIntradayQuotes, readsNextCallExpiryOnly: this.options.readsNextCallExpiryOnly, ...extras } satisfies DayDataReaderRequest);
    });
    this.requested.set(key, read.then((reply) => (reply?.ok ? new PrefetchedSymbolDay(reply.payload) : null)));
  }

  /** The day, read ahead (asked for now when it was not); null when the thread could not read it. */
  async take(symbol: string, tradingDate: string, intradayAfterLookTime: string, extras: DayDataRequestExtras = { intradayLookCheck: null, previousFileDay: null }): Promise<PrefetchedSymbolDay | null> {
    this.prefetch(symbol, tradingDate, intradayAfterLookTime, extras);
    const key = `${symbol}|${tradingDate}|${intradayAfterLookTime}`;
    const read = this.requested.get(key)!;
    this.requested.delete(key);
    return read;
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
