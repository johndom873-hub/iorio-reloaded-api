import { Worker } from "node:worker_threads";
import { contractKey } from "../../lib/optionContractKey.js";
import { engineWorkerExecArgv, engineWorkerModuleUrl } from "./engineWorkerThreads.js";
import type { SymbolFileEndOfDayRow, SymbolFileQuote } from "./backtestSymbolFile.js";

// Reading the symbol files ahead of the session (Marcelo 2026-10-12): a day's 10:00 quotes, end-of-day rows, open
// interest and intraday quotes are read on a thread of their own, a few days before the session reaches them, with the
// statements BacktestSymbolFile reads them with (backtestDayDataReaderWorker.ts). They come back as columns in
// transferred buffers, and the session's thread only builds the rows from them, in the order and with the values the
// file would have given. A day the thread could not read, or one with a value the columns cannot carry, is read from
// the file as before.

export type DayDataColumn = { kind: "string"; indices: Int32Array } | { kind: "number"; values: Float64Array; nulls: Uint8Array };

export interface DayDataTable {
  rowCount: number;
  columns: DayDataColumn[];
}

/** A strike range, both ends included. */
export interface StrikeRange {
  lowestStrike: number;
  highestStrike: number;
}

/** One symbol's day as the reader thread sends it. `intraday` and `intradayProbes` are null on a file without intraday tables. */
export interface DayDataPayload {
  strings: string[];
  quotes: DayDataTable;
  endOfDay: DayDataTable;
  openInterest: DayDataTable;
  /** Every intraday row of the day after `intradayAfterLookTime`, in primary-key order; null when the looks were probed instead. */
  intraday: DayDataTable | null;
  /**
   * Read instead of the rows (probeIntradayQuotesOnly): each look after `intradayAfterLookTime` that has rows, with the
   * strike of one of them within the request's probe range (null when none is, or the request gave no range).
   */
  intradayProbes: { lookTime: string; strikeWithinRange: number | null }[] | null;
  intradayAfterLookTime: string;
}

export type DayDataReaderRequest = { id: number; symbol: string; tradingDate: string; intradayAfterLookTime: string; probeIntradayQuotesOnly: boolean; probeStrikeRange: StrikeRange | null };
export type DayDataReaderReply = { id: number; ok: true; payload: DayDataPayload } | { id: number; ok: false; error: string };

/** The buffers of a payload, to transfer rather than copy. */
export function dayDataTransferList(payload: DayDataPayload): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const table of [payload.quotes, payload.endOfDay, payload.openInterest, payload.intraday]) {
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

/** One symbol's day read ahead: each part built when first asked for, as BacktestSymbolFile builds it. */
export class PrefetchedSymbolDay {
  constructor(private readonly payload: DayDataPayload) {}

  /** BacktestSymbolFile.loadQuotes. */
  quotes(): SymbolFileQuote[] {
    const { rowCount, columns } = this.payload.quotes;
    const [expiry, strike, right, bid, ask, bidSize, askSize] = columns.map((column) => cellReader(this.payload.strings, column));
    const rows: SymbolFileQuote[] = new Array(rowCount);
    for (let row = 0; row < rowCount; row++) rows[row] = { expiry: expiry!(row) as string, strike: strike!(row) as number, right: right!(row) as "C" | "P", bid: bid!(row) as number | null, ask: ask!(row) as number | null, bidSize: bidSize!(row) as number | null, askSize: askSize!(row) as number | null };
    return rows;
  }

  /** BacktestSymbolFile.loadEndOfDay. */
  endOfDay(): SymbolFileEndOfDayRow[] {
    const { rowCount, columns } = this.payload.endOfDay;
    const [expiry, strike, right, close, volume, bid, ask] = columns.map((column) => cellReader(this.payload.strings, column));
    const rows: SymbolFileEndOfDayRow[] = new Array(rowCount);
    for (let row = 0; row < rowCount; row++) rows[row] = { expiry: expiry!(row) as string, strike: strike!(row) as number, right: right!(row) as "C" | "P", close: close!(row) as number | null, volume: volume!(row) as number | null, bid: bid!(row) as number | null, ask: ask!(row) as number | null };
    return rows;
  }

  /** BacktestSymbolFile.loadOpenInterest. */
  openInterest(): Map<string, number> {
    const { rowCount, columns } = this.payload.openInterest;
    const [expiry, strike, right, openInterest] = columns.map((column) => cellReader(this.payload.strings, column));
    const byContract = new Map<string, number>();
    for (let row = 0; row < rowCount; row++) byContract.set(contractKey({ expiry: expiry!(row) as string, strike: strike!(row) as number, right: right!(row) as "C" | "P" }), openInterest!(row) as number);
    return byContract;
  }

  /**
   * BacktestSymbolFile.loadIntradayQuotes: the rows after `afterLookTime` through `throughLookTime` with a strike from
   * `lowestStrike` to `highestStrike` (the statement's comparisons, on the same strings and numbers), in the file's
   * order. Null when the day was read after another look time or the file has no intraday tables: the caller reads the
   * file then.
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

  /** The look times after `afterLookTime` that have rows, ascending; null when the day was not probed after that look time. */
  intradayProbedLookTimes(afterLookTime: string): string[] | null {
    if (this.payload.intradayProbes === null || afterLookTime !== this.payload.intradayAfterLookTime) return null;
    return this.payload.intradayProbes.map((look) => look.lookTime);
  }

  /**
   * Whether intradayQuotes(afterLookTime, …, range) would hold quotes at the look: false when the look has no rows at all,
   * true when its probed strike lies in the range. Null when the day was not probed after that look time, or its probe
   * cannot tell (no strike found in the probe range, or one outside this range): the caller asks the file then.
   */
  intradayLookHasStrikeWithin(afterLookTime: string, lookTime: string, range: StrikeRange): boolean | null {
    if (this.payload.intradayProbes === null || afterLookTime !== this.payload.intradayAfterLookTime) return null;
    const probe = this.payload.intradayProbes.find((look) => look.lookTime === lookTime);
    if (!probe) return false;
    return probe.strikeWithinRange !== null && probe.strikeWithinRange >= range.lowestStrike && probe.strikeWithinRange <= range.highestStrike ? true : null;
  }
}

/**
 * The reader thread of one session. prefetch() queues a symbol's day; take() hands it over once read (null when it
 * could not be: the caller reads the file). With `probeIntradayQuotesOnly` (a session whose looks after 10:00 only mark
 * what it holds) the intraday rows are not read: each look is probed for one row with a strike in the day's probe range.
 */
export class BacktestDayDataReader {
  private readonly worker: Worker;
  private readonly pending = new Map<number, (reply: DayDataReaderReply | null) => void>();
  private readonly requested = new Map<string, Promise<PrefetchedSymbolDay | null>>();
  private nextRequestId = 1;
  private stopped = false;

  constructor(private readonly options: { probeIntradayQuotesOnly: boolean } = { probeIntradayQuotesOnly: false }) {
    this.worker = new Worker(engineWorkerModuleUrl("backtestDayDataReaderWorker"), { execArgv: engineWorkerExecArgv() });
    this.worker.on("message", (reply: DayDataReaderReply) => {
      const resolve = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      resolve?.(reply);
    });
    const stop = () => {
      this.stopped = true;
      for (const resolve of this.pending.values()) resolve(null);
      this.pending.clear();
    };
    this.worker.on("error", stop);
    this.worker.on("exit", stop);
  }

  /** `probeStrikeRange`: where the looks are probed for a row (probeIntradayQuotesOnly); null: they are not. */
  prefetch(symbol: string, tradingDate: string, intradayAfterLookTime: string, probeStrikeRange: StrikeRange | null = null): void {
    const key = `${symbol}|${tradingDate}|${intradayAfterLookTime}`;
    if (this.requested.has(key)) return;
    const read = new Promise<DayDataReaderReply | null>((resolve) => {
      if (this.stopped) return resolve(null);
      const id = this.nextRequestId++;
      this.pending.set(id, resolve);
      this.worker.postMessage({ id, symbol, tradingDate, intradayAfterLookTime, probeIntradayQuotesOnly: this.options.probeIntradayQuotesOnly, probeStrikeRange } satisfies DayDataReaderRequest);
    });
    this.requested.set(key, read.then((reply) => (reply?.ok ? new PrefetchedSymbolDay(reply.payload) : null)));
  }

  /** The day, read ahead (asked for now when it was not); null when the thread could not read it. */
  async take(symbol: string, tradingDate: string, intradayAfterLookTime: string, probeStrikeRange: StrikeRange | null = null): Promise<PrefetchedSymbolDay | null> {
    this.prefetch(symbol, tradingDate, intradayAfterLookTime, probeStrikeRange);
    const key = `${symbol}|${tradingDate}|${intradayAfterLookTime}`;
    const read = this.requested.get(key)!;
    this.requested.delete(key);
    return read;
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.worker.terminate();
  }
}
