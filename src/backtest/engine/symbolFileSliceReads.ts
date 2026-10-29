import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { DayDataColumn, DayDataTable } from "./backtestDayDataReader.js";
import type { NextCallExpiryDay, SymbolFileEndOfDayRow, SymbolFileQuote } from "./backtestSymbolFile.js";
import {
  dailySliceLookMinute,
  dayNumberOf,
  dayNumberOfKey,
  daysToExpiryOfKey,
  decodeSlice,
  decodeSliceInto,
  endOfDayColumns,
  intradayQuoteColumns,
  isoDateOfDayNumber,
  lookMinuteOf,
  lookMinuteOfKey,
  lookTimeOfMinute,
  sliceColumn,
  sliceContractCount,
  sliceKey,
  sliceValueAt,
  tenOClockLookMinute,
  tenOClockQuoteColumns,
  type SliceColumnKind,
  type SliceNumberColumn,
} from "./symbolFileSlices.js";

// BacktestSymbolFile's option reads on a schema 4 file (symbolFileSlices.ts): the same rows, in the same order and with
// the same values as its statements give on a schema 3 file. The 10:00 quotes are read from ten_oclock_quote_slices,
// every intraday look (10:00 included) from intraday_quote_slices, as schema 3 reads quotes and intraday_quotes.

/** The expiries the engine reads: 0..45 days out for the 10:00 and intraday quotes, 0..46 for the end of day. */
const quoteWindowDays = 45;
const endOfDayWindowDays = 46;
const lastDaysToExpiry = 65_535;

export type StoredSlice = [key: number, data: Uint8Array];

/** A slice's contracts as quotes: every one, or those of one right with a strike in a range. */
function quotesOfSlice(data: Uint8Array, expiry: string, kinds: readonly SliceColumnKind[], withSizes: boolean, right: "C" | "P" | null = null, lowestStrike = Number.NEGATIVE_INFINITY, highestStrike = Number.POSITIVE_INFINITY): SymbolFileQuote[] {
  const slice = decodeSlice(data, kinds);
  const [strikes, , bids, asks, bidSizes, askSizes] = slice.columns as [SliceNumberColumn, null, SliceNumberColumn, SliceNumberColumn, SliceNumberColumn, SliceNumberColumn];
  const quotes: SymbolFileQuote[] = [];
  for (let index = 0; index < slice.count; index++) {
    const contractRight = slice.puts[index] === 1 ? "P" : "C";
    const strike = strikes.values[index]!;
    if ((right !== null && contractRight !== right) || strike < lowestStrike || strike > highestStrike) continue;
    quotes.push({ expiry, strike, right: contractRight, bid: sliceValueAt(bids, index), ask: sliceValueAt(asks, index), bidSize: withSizes ? sliceValueAt(bidSizes, index) : null, askSize: withSizes ? sliceValueAt(askSizes, index) : null });
  }
  return quotes;
}

/** A slice's contracts as end-of-day rows: every one, or those of one right with a strike in a range. */
function endOfDayRowsOfSlice(data: Uint8Array, expiry: string, right: "C" | "P" | null = null, lowestStrike = Number.NEGATIVE_INFINITY, highestStrike = Number.POSITIVE_INFINITY): SymbolFileEndOfDayRow[] {
  const slice = decodeSlice(data, endOfDayColumns);
  const [strikes, , closes, volumes, bids, asks] = slice.columns as [SliceNumberColumn, null, SliceNumberColumn, SliceNumberColumn, SliceNumberColumn, SliceNumberColumn];
  const rows: SymbolFileEndOfDayRow[] = [];
  for (let index = 0; index < slice.count; index++) {
    const contractRight = slice.puts[index] === 1 ? "P" : "C";
    const strike = strikes.values[index]!;
    if ((right !== null && contractRight !== right) || strike < lowestStrike || strike > highestStrike) continue;
    rows.push({ expiry, strike, right: contractRight, close: sliceValueAt(closes, index), volume: sliceValueAt(volumes, index), bid: sliceValueAt(bids, index), ask: sliceValueAt(asks, index) });
  }
  return rows;
}

/** Whether a slice holds a contract with a strike from `lowestStrike` to `highestStrike`. */
function sliceHasStrikeWithin(data: Uint8Array, kinds: readonly SliceColumnKind[], lowestStrike: number, highestStrike: number): boolean {
  const count = sliceContractCount(data);
  const strikes = { values: new Float64Array(count), nulls: new Uint8Array(count) };
  decodeSliceInto(data, kinds.slice(0, 1), [strikes], null, 0);
  for (let index = 0; index < count; index++) if (strikes.values[index]! >= lowestStrike && strikes.values[index]! <= highestStrike) return true;
  return false;
}

const expiryOfKey = (key: number): string => isoDateOfDayNumber(dayNumberOfKey(key) + daysToExpiryOfKey(key));

/** One slice table's reads by key. */
class SliceTable {
  private readonly between: StatementSync;
  private readonly byKey: StatementSync;
  private readonly firstKeyAfter: StatementSync;

  constructor(database: DatabaseSync, readonly name: string) {
    this.between = database.prepare(`SELECT key, data FROM ${name} WHERE key BETWEEN ? AND ? ORDER BY key`);
    this.between.setReturnArrays(true);
    this.byKey = database.prepare(`SELECT data FROM ${name} WHERE key = ?`);
    this.firstKeyAfter = database.prepare(`SELECT key FROM ${name} WHERE key > ? AND key < ? ORDER BY key LIMIT 1`);
  }

  /** The slices of one day and look expiring within `windowDays`, in key order. */
  slicesOf(dayNumber: number, lookMinute: number, windowDays: number): StoredSlice[] {
    return this.between.all(sliceKey(dayNumber, lookMinute, 0), sliceKey(dayNumber, lookMinute, windowDays)) as unknown as StoredSlice[];
  }

  sliceAt(dayNumber: number, lookMinute: number, expiry: string): Uint8Array | null {
    const daysToExpiry = dayNumberOf(expiry) - dayNumber;
    if (daysToExpiry < 0 || daysToExpiry > lastDaysToExpiry) return null;
    return (this.byKey.get(sliceKey(dayNumber, lookMinute, daysToExpiry)) as { data: Uint8Array } | undefined)?.data ?? null;
  }

  /** The day's first look after `lookMinute` with a slice of any expiry; null after the last. */
  nextLookMinuteAfter(dayNumber: number, lookMinute: number): number | null {
    const found = this.firstKeyAfter.get(sliceKey(dayNumber, lookMinute, lastDaysToExpiry), sliceKey(dayNumber + 1, 0, 0)) as { key: number } | undefined;
    return found === undefined ? null : lookMinuteOfKey(found.key);
  }
}

export class SymbolFileSliceReads {
  private readonly tenOClock: SliceTable;
  private readonly intraday: SliceTable;
  private readonly endOfDay: SliceTable;
  private readonly firstCallTenOClockSliceBetween: StatementSync;
  private readonly tenOClockCountsBetween: StatementSync;
  private readonly tenOClockAskAboveZeroBetween: StatementSync;
  private readonly volumeBetween: StatementSync;
  private readonly tenOClockCallKeysBetween: StatementSync;
  private readonly tenOClockPutKeysBetween: StatementSync;

  constructor(database: DatabaseSync) {
    this.tenOClock = new SliceTable(database, "ten_oclock_quote_slices");
    this.intraday = new SliceTable(database, "intraday_quote_slices");
    this.endOfDay = new SliceTable(database, "end_of_day_slices");
    this.firstCallTenOClockSliceBetween = database.prepare("SELECT key FROM ten_oclock_quote_slices WHERE key BETWEEN ? AND ? AND call_count > 0 ORDER BY key LIMIT 1");
    this.tenOClockCountsBetween = database.prepare("SELECT sum(call_count) AS calls, sum(put_count) AS puts FROM ten_oclock_quote_slices WHERE key BETWEEN ? AND ?");
    this.tenOClockAskAboveZeroBetween = database.prepare("SELECT 1 AS found FROM ten_oclock_quote_slices WHERE key BETWEEN ? AND ? AND has_ask_above_zero = 1 LIMIT 1");
    this.volumeBetween = database.prepare("SELECT 1 AS found FROM end_of_day_slices WHERE key BETWEEN ? AND ? AND has_volume = 1 LIMIT 1");
    this.tenOClockCallKeysBetween = database.prepare("SELECT key FROM ten_oclock_quote_slices WHERE key BETWEEN ? AND ? AND call_count > 0 ORDER BY key");
    this.tenOClockCallKeysBetween.setReturnArrays(true);
    this.tenOClockPutKeysBetween = database.prepare("SELECT key FROM ten_oclock_quote_slices WHERE key BETWEEN ? AND ? AND put_count > 0 ORDER BY key");
    this.tenOClockPutKeysBetween.setReturnArrays(true);
  }

  /** A day's 10:00 quote slices expiring within 45 days (the reader thread's quotes). */
  tenOClockSlicesOf(tradingDate: string): StoredSlice[] {
    return this.tenOClock.slicesOf(dayNumberOf(tradingDate), tenOClockLookMinute, quoteWindowDays);
  }

  /** A day's end-of-day slices expiring within 46 days (the reader thread's end of day). */
  endOfDaySlicesOf(tradingDate: string): StoredSlice[] {
    return this.endOfDay.slicesOf(dayNumberOf(tradingDate), dailySliceLookMinute, endOfDayWindowDays);
  }

  /** Every intraday slice of the looks after `afterLookTime` expiring within 45 days, look by look in key order (the reader thread's intraday rows). */
  intradaySlicesAfter(tradingDate: string, afterLookTime: string): StoredSlice[] {
    const dayNumber = dayNumberOf(tradingDate);
    const slices: StoredSlice[] = [];
    for (let lookMinute = this.intraday.nextLookMinuteAfter(dayNumber, lookMinuteOf(afterLookTime)); lookMinute !== null; lookMinute = this.intraday.nextLookMinuteAfter(dayNumber, lookMinute)) for (const slice of this.intraday.slicesOf(dayNumber, lookMinute, quoteWindowDays)) slices.push(slice);
    return slices;
  }

  loadQuotes(tradingDate: string): SymbolFileQuote[] {
    const quotes: SymbolFileQuote[] = [];
    for (const [key, data] of this.tenOClockSlicesOf(tradingDate)) for (const quote of quotesOfSlice(data, expiryOfKey(key), tenOClockQuoteColumns, true)) quotes.push(quote);
    return quotes;
  }

  loadEndOfDay(tradingDate: string): SymbolFileEndOfDayRow[] {
    const rows: SymbolFileEndOfDayRow[] = [];
    for (const [key, data] of this.endOfDaySlicesOf(tradingDate)) for (const row of endOfDayRowsOfSlice(data, expiryOfKey(key))) rows.push(row);
    return rows;
  }

  /** NextCallExpiryDay's parts besides its rows: the expiry's 10:00 slice and the previous day's end-of-day slice of it. */
  nextCallExpiryParts(tradingDate: string, previousFileDay: string | null): Omit<NextCallExpiryDay, "quotes" | "previousEndOfDay"> & { quoteSlice: StoredSlice | null; previousEndOfDaySlice: StoredSlice | null } {
    const dayNumber = dayNumberOf(tradingDate);
    const first = this.firstCallTenOClockSliceBetween.get(sliceKey(dayNumber, tenOClockLookMinute, 1), sliceKey(dayNumber, tenOClockLookMinute, quoteWindowDays)) as { key: number } | undefined;
    const expiry = first === undefined ? null : expiryOfKey(first.key);
    const counts = this.tenOClockCountsBetween.get(sliceKey(dayNumber, tenOClockLookMinute, 0), sliceKey(dayNumber, tenOClockLookMinute, quoteWindowDays)) as { calls: number | null; puts: number | null };
    let previousEndOfDaySlice: StoredSlice | null = null;
    let previousHasVolume: boolean | null = null;
    if (previousFileDay !== null) {
      const previousDayNumber = dayNumberOf(previousFileDay);
      previousHasVolume = this.volumeBetween.get(sliceKey(previousDayNumber, dailySliceLookMinute, 0), sliceKey(previousDayNumber, dailySliceLookMinute, endOfDayWindowDays)) !== undefined;
      if (expiry !== null && dayNumberOf(expiry) - previousDayNumber <= endOfDayWindowDays) {
        const data = this.endOfDay.sliceAt(previousDayNumber, dailySliceLookMinute, expiry);
        if (data !== null) previousEndOfDaySlice = [sliceKey(previousDayNumber, dailySliceLookMinute, dayNumberOf(expiry) - previousDayNumber), data];
      }
    }
    return {
      expiry,
      quoteSlice: first === undefined ? null : [first.key, this.tenOClock.sliceAt(dayNumber, tenOClockLookMinute, expiry!)!],
      quoteCountByRight: { C: Number(counts.calls ?? 0), P: Number(counts.puts ?? 0) },
      hasAskAboveZero: this.tenOClockAskAboveZeroBetween.get(sliceKey(dayNumber, tenOClockLookMinute, 0), sliceKey(dayNumber, tenOClockLookMinute, quoteWindowDays)) !== undefined,
      previousEndOfDaySlice,
      previousHasVolume,
    };
  }

  loadNextCallExpiryDay(tradingDate: string, previousFileDay: string | null): NextCallExpiryDay {
    const { quoteSlice, previousEndOfDaySlice, ...parts } = this.nextCallExpiryParts(tradingDate, previousFileDay);
    return {
      expiry: parts.expiry,
      quotes: quoteSlice === null ? [] : quotesOfSlice(quoteSlice[1], expiryOfKey(quoteSlice[0]), tenOClockQuoteColumns, true),
      quoteCountByRight: parts.quoteCountByRight,
      hasAskAboveZero: parts.hasAskAboveZero,
      previousEndOfDay: previousEndOfDaySlice === null ? [] : endOfDayRowsOfSlice(previousEndOfDaySlice[1], expiryOfKey(previousEndOfDaySlice[0])),
      previousHasVolume: parts.previousHasVolume,
    };
  }

  loadQuotesOfContract(tradingDate: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileQuote[] {
    const dayNumber = dayNumberOf(tradingDate);
    if (dayNumberOf(contract.expiry) - dayNumber > quoteWindowDays) return [];
    const data = this.tenOClock.sliceAt(dayNumber, tenOClockLookMinute, contract.expiry);
    return data === null ? [] : quotesOfSlice(data, contract.expiry, tenOClockQuoteColumns, true, contract.right, lowestStrike, highestStrike);
  }

  loadEndOfDayOfContract(tradingDate: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileEndOfDayRow[] {
    const dayNumber = dayNumberOf(tradingDate);
    if (dayNumberOf(contract.expiry) - dayNumber > endOfDayWindowDays) return [];
    const data = this.endOfDay.sliceAt(dayNumber, dailySliceLookMinute, contract.expiry);
    return data === null ? [] : endOfDayRowsOfSlice(data, contract.expiry, contract.right, lowestStrike, highestStrike);
  }

  loadIntradayQuotes(tradingDate: string, afterLookTime: string, throughLookTime: string, lowestStrike: number, highestStrike: number): Map<string, SymbolFileQuote[]> {
    const dayNumber = dayNumberOf(tradingDate);
    const quotesByLookTime = new Map<string, SymbolFileQuote[]>();
    const throughMinute = lookMinuteOf(throughLookTime);
    for (let lookMinute = this.intraday.nextLookMinuteAfter(dayNumber, lookMinuteOf(afterLookTime)); lookMinute !== null && lookMinute <= throughMinute; lookMinute = this.intraday.nextLookMinuteAfter(dayNumber, lookMinute)) {
      const quotes: SymbolFileQuote[] = [];
      for (const [key, data] of this.intraday.slicesOf(dayNumber, lookMinute, quoteWindowDays)) for (const quote of quotesOfSlice(data, expiryOfKey(key), intradayQuoteColumns, false, null, lowestStrike, highestStrike)) quotes.push(quote);
      if (quotes.length > 0) quotesByLookTime.set(lookTimeOfMinute(lookMinute), quotes);
    }
    return quotesByLookTime;
  }

  loadIntradayQuotesOfContract(tradingDate: string, lookTime: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileQuote[] {
    const dayNumber = dayNumberOf(tradingDate);
    if (dayNumberOf(contract.expiry) - dayNumber > quoteWindowDays) return [];
    const data = this.intraday.sliceAt(dayNumber, lookMinuteOf(lookTime), contract.expiry);
    return data === null ? [] : quotesOfSlice(data, contract.expiry, intradayQuoteColumns, false, contract.right, lowestStrike, highestStrike);
  }

  hasIntradayQuoteWithin(tradingDate: string, lookTime: string, lowestStrike: number, highestStrike: number): boolean {
    for (const [, data] of this.intraday.slicesOf(dayNumberOf(tradingDate), lookMinuteOf(lookTime), quoteWindowDays)) if (sliceHasStrikeWithin(data, intradayQuoteColumns, lowestStrike, highestStrike)) return true;
    return false;
  }

  nextIntradayLookTime(tradingDate: string, afterLookTime: string): string | null {
    const next = this.intraday.nextLookMinuteAfter(dayNumberOf(tradingDate), lookMinuteOf(afterLookTime));
    return next === null ? null : lookTimeOfMinute(next);
  }

  private tenOClockExpiriesWith(tradingDate: string, right: "C" | "P"): string[] {
    const dayNumber = dayNumberOf(tradingDate);
    const keys = (right === "C" ? this.tenOClockCallKeysBetween : this.tenOClockPutKeysBetween).all(sliceKey(dayNumber, tenOClockLookMinute, 0), sliceKey(dayNumber, tenOClockLookMinute, lastDaysToExpiry)) as unknown as [number][];
    return keys.map(([key]) => expiryOfKey(key));
  }

  loadPutExpiries(tradingDate: string): string[] {
    return this.tenOClockExpiriesWith(tradingDate, "P");
  }

  loadCallExpiries(tradingDate: string): string[] {
    return this.tenOClockExpiriesWith(tradingDate, "C");
  }

  /** One expiry's contracts of one right: the 10:00 quotes (lookTime null, with sizes) or an intraday look's (with sizes when asked). */
  quotesOfExpiry(tradingDate: string, lookTime: string | null, expiry: string, right: "C" | "P", withIntradaySizes: boolean): SymbolFileQuote[] {
    const dayNumber = dayNumberOf(tradingDate);
    const data = lookTime === null ? this.tenOClock.sliceAt(dayNumber, tenOClockLookMinute, expiry) : this.intraday.sliceAt(dayNumber, lookMinuteOf(lookTime), expiry);
    if (data === null) return [];
    return quotesOfSlice(data, expiry, lookTime === null ? tenOClockQuoteColumns : intradayQuoteColumns, lookTime === null || withIntradaySizes, right);
  }
}

/** Shares one strings table across a day's tables, as the reader thread's encoding does. */
export class DayDataStrings {
  readonly strings: string[] = [];
  private readonly indexByString = new Map<string, number>();

  indexOf(value: string): number {
    let index = this.indexByString.get(value);
    if (index === undefined) {
      index = this.strings.length;
      this.strings.push(value);
      this.indexByString.set(value, index);
    }
    return index;
  }
}

/**
 * Slices as one of the reader thread's tables: [look time when `withLookTime`], expiry, strike, right, then the number
 * columns asked for (positions in the slice), each as BacktestSymbolFile's conversions give them.
 */
export function dayDataTableOfSlices(slices: readonly StoredSlice[], kinds: readonly SliceColumnKind[], valueColumns: readonly number[], strings: DayDataStrings, withLookTime: boolean): DayDataTable {
  let rowCount = 0;
  for (const [, data] of slices) rowCount += sliceContractCount(data);
  const lookTimes = withLookTime ? new Int32Array(rowCount) : null;
  const expiries = new Int32Array(rowCount);
  const strikes: SliceNumberColumn = { values: new Float64Array(rowCount), nulls: new Uint8Array(rowCount) };
  const puts = new Uint8Array(rowCount);
  const values = valueColumns.map(() => ({ values: new Float64Array(rowCount), nulls: new Uint8Array(rowCount) }));
  const targets: (SliceNumberColumn | undefined)[] = new Array(kinds.length);
  targets[sliceColumn.strike] = strikes;
  valueColumns.forEach((column, valueIndex) => (targets[column] = values[valueIndex]));
  const callIndex = strings.indexOf("C");
  const putIndex = strings.indexOf("P");
  let at = 0;
  for (const [key, data] of slices) {
    const count = decodeSliceInto(data, kinds, targets, puts, at);
    if (lookTimes) lookTimes.fill(strings.indexOf(lookTimeOfMinute(lookMinuteOfKey(key))), at, at + count);
    expiries.fill(strings.indexOf(expiryOfKey(key)), at, at + count);
    at += count;
  }
  const rights = new Int32Array(rowCount);
  for (let index = 0; index < rowCount; index++) rights[index] = puts[index] === 1 ? putIndex : callIndex;
  const columns: DayDataColumn[] = [{ kind: "string", indices: expiries }, { kind: "number", ...strikes }, { kind: "string", indices: rights }, ...values.map((column): DayDataColumn => ({ kind: "number", ...column }))];
  return { rowCount, columns: lookTimes ? [{ kind: "string", indices: lookTimes }, ...columns] : columns };
}

/** The positions the reader thread's quote tables read (bid, ask, sizes), its intraday tables (bid, ask) and its end-of-day tables (close, volume, bid, ask). */
export const dayDataQuoteValueColumns = [sliceColumn.bid, sliceColumn.ask, sliceColumn.bidSize, sliceColumn.askSize] as const;
export const dayDataIntradayValueColumns = [sliceColumn.bid, sliceColumn.ask] as const;
export const dayDataEndOfDayValueColumns = [sliceColumn.close, sliceColumn.volume, sliceColumn.endOfDayBid, sliceColumn.endOfDayAsk] as const;
