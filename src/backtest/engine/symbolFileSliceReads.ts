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
  isoDateOfDayNumber,
  laterLookQuoteColumns,
  lookMinuteOf,
  lookMinuteOfKey,
  lookTimeOfMinute,
  quoteColumnsOfLook,
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
// the same values as its statements give on a schema 3 file. The 10:00 quotes are the 10:00 look's slices; the intraday
// reads cover the looks after 10:00 (the engine reads 10:00 from the 10:00 quotes) and refuse an earlier look.

/** The expiries the engine reads: 0..45 days out for the 10:00 and intraday quotes, 0..46 for the end of day. */
const quoteWindowDays = 45;
const endOfDayWindowDays = 46;
const lastDaysToExpiry = 65_535;

type StoredSlice = [key: number, data: Uint8Array];

/** The minute of a later look read on its own; 10:00 and earlier are refused (10:00 is read from the 10:00 quotes). */
function laterLookMinuteOf(lookTime: string): number {
  const minute = lookMinuteOf(lookTime);
  if (minute <= tenOClockLookMinute) throw new Error(`Schema 4 files keep intraday quotes after 10:00 only (asked for ${lookTime}); 10:00 is read from the 10:00 quotes.`);
  return minute;
}

/** The minute a range of later looks starts after: 10:00 or later. */
function afterLookMinuteOf(afterLookTime: string): number {
  const minute = lookMinuteOf(afterLookTime);
  if (minute < tenOClockLookMinute) throw new Error(`Schema 4 files keep intraday quotes after 10:00 only (asked for the looks after ${afterLookTime}); 10:00 is read from the 10:00 quotes.`);
  return minute;
}

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

const expiryOfKey = (key: number): string => isoDateOfDayNumber(dayNumberOfKey(key) + daysToExpiryOfKey(key));

export class SymbolFileSliceReads {
  private readonly quoteSlicesBetween: StatementSync;
  private readonly endOfDaySlicesBetween: StatementSync;
  private readonly quoteSliceByKey: StatementSync;
  private readonly endOfDaySliceByKey: StatementSync;
  private readonly firstCallSliceBetween: StatementSync;
  private readonly contractCountsBetween: StatementSync;
  private readonly askAboveZeroBetween: StatementSync;
  private readonly volumeBetween: StatementSync;
  private readonly firstQuoteKeyAfter: StatementSync;
  private readonly callSliceKeysBetween: StatementSync;
  private readonly putSliceKeysBetween: StatementSync;

  constructor(database: DatabaseSync) {
    const arrays = (sql: string): StatementSync => {
      const statement = database.prepare(sql);
      statement.setReturnArrays(true);
      return statement;
    };
    this.quoteSlicesBetween = arrays("SELECT key, data FROM option_quote_slices WHERE key BETWEEN ? AND ? ORDER BY key");
    this.endOfDaySlicesBetween = arrays("SELECT key, data FROM end_of_day_slices WHERE key BETWEEN ? AND ? ORDER BY key");
    this.quoteSliceByKey = database.prepare("SELECT data FROM option_quote_slices WHERE key = ?");
    this.endOfDaySliceByKey = database.prepare("SELECT data FROM end_of_day_slices WHERE key = ?");
    this.firstCallSliceBetween = database.prepare("SELECT key FROM option_quote_slices WHERE key BETWEEN ? AND ? AND call_count > 0 ORDER BY key LIMIT 1");
    this.contractCountsBetween = database.prepare("SELECT sum(call_count) AS calls, sum(put_count) AS puts FROM option_quote_slices WHERE key BETWEEN ? AND ?");
    this.askAboveZeroBetween = database.prepare("SELECT 1 AS found FROM option_quote_slices WHERE key BETWEEN ? AND ? AND has_ask_above_zero = 1 LIMIT 1");
    this.volumeBetween = database.prepare("SELECT 1 AS found FROM end_of_day_slices WHERE key BETWEEN ? AND ? AND has_volume = 1 LIMIT 1");
    this.firstQuoteKeyAfter = database.prepare("SELECT key FROM option_quote_slices WHERE key > ? AND key < ? ORDER BY key LIMIT 1");
    this.callSliceKeysBetween = arrays("SELECT key FROM option_quote_slices WHERE key BETWEEN ? AND ? AND call_count > 0 ORDER BY key");
    this.putSliceKeysBetween = arrays("SELECT key FROM option_quote_slices WHERE key BETWEEN ? AND ? AND put_count > 0 ORDER BY key");
  }

  /** The slices of one look (or the end of day) of a day, expiring within `windowDays`, in key order. */
  quoteSlicesOf(dayNumber: number, lookMinute: number, windowDays: number): StoredSlice[] {
    return this.quoteSlicesBetween.all(sliceKey(dayNumber, lookMinute, 0), sliceKey(dayNumber, lookMinute, windowDays)) as unknown as StoredSlice[];
  }

  endOfDaySlicesOf(dayNumber: number, windowDays: number): StoredSlice[] {
    return this.endOfDaySlicesBetween.all(sliceKey(dayNumber, dailySliceLookMinute, 0), sliceKey(dayNumber, dailySliceLookMinute, windowDays)) as unknown as StoredSlice[];
  }

  private quoteSliceAt(dayNumber: number, lookMinute: number, expiry: string): Uint8Array | null {
    const daysToExpiry = dayNumberOf(expiry) - dayNumber;
    if (daysToExpiry < 0 || daysToExpiry > lastDaysToExpiry) return null;
    return (this.quoteSliceByKey.get(sliceKey(dayNumber, lookMinute, daysToExpiry)) as { data: Uint8Array } | undefined)?.data ?? null;
  }

  private endOfDaySliceAt(dayNumber: number, expiry: string): Uint8Array | null {
    const daysToExpiry = dayNumberOf(expiry) - dayNumber;
    if (daysToExpiry < 0 || daysToExpiry > lastDaysToExpiry) return null;
    return (this.endOfDaySliceByKey.get(sliceKey(dayNumber, dailySliceLookMinute, daysToExpiry)) as { data: Uint8Array } | undefined)?.data ?? null;
  }

  loadQuotes(tradingDate: string): SymbolFileQuote[] {
    const quotes: SymbolFileQuote[] = [];
    for (const [key, data] of this.quoteSlicesOf(dayNumberOf(tradingDate), tenOClockLookMinute, quoteWindowDays)) for (const quote of quotesOfSlice(data, expiryOfKey(key), tenOClockQuoteColumns, true)) quotes.push(quote);
    return quotes;
  }

  loadEndOfDay(tradingDate: string): SymbolFileEndOfDayRow[] {
    const rows: SymbolFileEndOfDayRow[] = [];
    for (const [key, data] of this.endOfDaySlicesOf(dayNumberOf(tradingDate), endOfDayWindowDays)) for (const row of endOfDayRowsOfSlice(data, expiryOfKey(key))) rows.push(row);
    return rows;
  }

  /** NextCallExpiryDay's parts besides its rows: the expiry's 10:00 slice and the previous day's end-of-day slice of it. */
  nextCallExpiryParts(tradingDate: string, previousFileDay: string | null): Omit<NextCallExpiryDay, "quotes" | "previousEndOfDay"> & { quoteSlice: StoredSlice | null; previousEndOfDaySlice: StoredSlice | null } {
    const dayNumber = dayNumberOf(tradingDate);
    const first = this.firstCallSliceBetween.get(sliceKey(dayNumber, tenOClockLookMinute, 1), sliceKey(dayNumber, tenOClockLookMinute, quoteWindowDays)) as { key: number } | undefined;
    const expiry = first === undefined ? null : expiryOfKey(first.key);
    const counts = this.contractCountsBetween.get(sliceKey(dayNumber, tenOClockLookMinute, 0), sliceKey(dayNumber, tenOClockLookMinute, quoteWindowDays)) as { calls: number | null; puts: number | null };
    let previousEndOfDaySlice: StoredSlice | null = null;
    let previousHasVolume: boolean | null = null;
    if (previousFileDay !== null) {
      const previousDayNumber = dayNumberOf(previousFileDay);
      previousHasVolume = this.volumeBetween.get(sliceKey(previousDayNumber, dailySliceLookMinute, 0), sliceKey(previousDayNumber, dailySliceLookMinute, endOfDayWindowDays)) !== undefined;
      if (expiry !== null && dayNumberOf(expiry) - previousDayNumber <= endOfDayWindowDays) {
        const data = this.endOfDaySliceAt(previousDayNumber, expiry);
        if (data !== null) previousEndOfDaySlice = [sliceKey(previousDayNumber, dailySliceLookMinute, dayNumberOf(expiry) - previousDayNumber), data];
      }
    }
    return {
      expiry,
      quoteSlice: first === undefined ? null : [first.key, this.quoteSliceAt(dayNumber, tenOClockLookMinute, expiry!)!],
      quoteCountByRight: { C: Number(counts.calls ?? 0), P: Number(counts.puts ?? 0) },
      hasAskAboveZero: this.askAboveZeroBetween.get(sliceKey(dayNumber, tenOClockLookMinute, 0), sliceKey(dayNumber, tenOClockLookMinute, quoteWindowDays)) !== undefined,
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
    const data = this.quoteSliceAt(dayNumber, tenOClockLookMinute, contract.expiry);
    return data === null ? [] : quotesOfSlice(data, contract.expiry, tenOClockQuoteColumns, true, contract.right, lowestStrike, highestStrike);
  }

  loadEndOfDayOfContract(tradingDate: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileEndOfDayRow[] {
    const dayNumber = dayNumberOf(tradingDate);
    if (dayNumberOf(contract.expiry) - dayNumber > endOfDayWindowDays) return [];
    const data = this.endOfDaySliceAt(dayNumber, contract.expiry);
    return data === null ? [] : endOfDayRowsOfSlice(data, contract.expiry, contract.right, lowestStrike, highestStrike);
  }

  loadIntradayQuotes(tradingDate: string, afterLookTime: string, throughLookTime: string, lowestStrike: number, highestStrike: number): Map<string, SymbolFileQuote[]> {
    const dayNumber = dayNumberOf(tradingDate);
    const quotesByLookTime = new Map<string, SymbolFileQuote[]>();
    const throughMinute = lookMinuteOf(throughLookTime);
    for (let lookMinute = this.nextLookMinuteAfter(dayNumber, afterLookMinuteOf(afterLookTime)); lookMinute !== null && lookMinute <= throughMinute; lookMinute = this.nextLookMinuteAfter(dayNumber, lookMinute)) {
      const quotes: SymbolFileQuote[] = [];
      for (const [key, data] of this.quoteSlicesOf(dayNumber, lookMinute, quoteWindowDays)) for (const quote of quotesOfSlice(data, expiryOfKey(key), laterLookQuoteColumns, false, null, lowestStrike, highestStrike)) quotes.push(quote);
      if (quotes.length > 0) quotesByLookTime.set(lookTimeOfMinute(lookMinute), quotes);
    }
    return quotesByLookTime;
  }

  loadIntradayQuotesOfContract(tradingDate: string, lookTime: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileQuote[] {
    const dayNumber = dayNumberOf(tradingDate);
    const lookMinute = laterLookMinuteOf(lookTime);
    if (dayNumberOf(contract.expiry) - dayNumber > quoteWindowDays) return [];
    const data = this.quoteSliceAt(dayNumber, lookMinute, contract.expiry);
    return data === null ? [] : quotesOfSlice(data, contract.expiry, laterLookQuoteColumns, false, contract.right, lowestStrike, highestStrike);
  }

  hasIntradayQuoteWithin(tradingDate: string, lookTime: string, lowestStrike: number, highestStrike: number): boolean {
    const lookMinute = laterLookMinuteOf(lookTime);
    for (const [, data] of this.quoteSlicesOf(dayNumberOf(tradingDate), lookMinute, quoteWindowDays)) if (sliceHasStrikeWithin(data, laterLookQuoteColumns, lowestStrike, highestStrike)) return true;
    return false;
  }

  /** Every slice of the looks after `afterLookTime` expiring within 45 days, look by look in key order (the reader thread's intraday rows). */
  laterLookSlicesAfter(tradingDate: string, afterLookTime: string): StoredSlice[] {
    const dayNumber = dayNumberOf(tradingDate);
    const slices: StoredSlice[] = [];
    for (let lookMinute = this.nextLookMinuteAfter(dayNumber, afterLookMinuteOf(afterLookTime)); lookMinute !== null; lookMinute = this.nextLookMinuteAfter(dayNumber, lookMinute)) for (const slice of this.quoteSlicesOf(dayNumber, lookMinute, quoteWindowDays)) slices.push(slice);
    return slices;
  }

  /** The first look after `lookMinute` with a slice of any expiry; null after the last. */
  private nextLookMinuteAfter(dayNumber: number, lookMinute: number): number | null {
    const found = this.firstQuoteKeyAfter.get(sliceKey(dayNumber, lookMinute, lastDaysToExpiry), sliceKey(dayNumber + 1, 0, 0)) as { key: number } | undefined;
    return found === undefined ? null : lookMinuteOfKey(found.key);
  }

  nextIntradayLookTime(tradingDate: string, afterLookTime: string): string | null {
    const next = this.nextLookMinuteAfter(dayNumberOf(tradingDate), afterLookMinuteOf(afterLookTime));
    return next === null ? null : lookTimeOfMinute(next);
  }

  private expiriesWithRight(tradingDate: string, right: "C" | "P"): string[] {
    const dayNumber = dayNumberOf(tradingDate);
    const keys = (right === "C" ? this.callSliceKeysBetween : this.putSliceKeysBetween).all(sliceKey(dayNumber, tenOClockLookMinute, 0), sliceKey(dayNumber, tenOClockLookMinute, lastDaysToExpiry)) as unknown as [number][];
    return keys.map(([key]) => expiryOfKey(key));
  }

  loadPutExpiries(tradingDate: string): string[] {
    return this.expiriesWithRight(tradingDate, "P");
  }

  loadCallExpiries(tradingDate: string): string[] {
    return this.expiriesWithRight(tradingDate, "C");
  }

  /** One expiry's contracts of one right at 10:00 (with sizes) or at a later look (with sizes only when asked). */
  quotesOfExpiry(tradingDate: string, lookTime: string | null, expiry: string, right: "C" | "P", withLaterLookSizes: boolean): SymbolFileQuote[] {
    const dayNumber = dayNumberOf(tradingDate);
    const lookMinute = lookTime === null ? tenOClockLookMinute : laterLookMinuteOf(lookTime);
    const data = this.quoteSliceAt(dayNumber, lookMinute, expiry);
    if (data === null) return [];
    return quotesOfSlice(data, expiry, quoteColumnsOfLook(lookMinute), lookTime === null || withLaterLookSizes, right);
  }
}

/** Whether a slice holds a contract with a strike from `lowestStrike` to `highestStrike`. */
function sliceHasStrikeWithin(data: Uint8Array, kinds: readonly SliceColumnKind[], lowestStrike: number, highestStrike: number): boolean {
  const count = sliceContractCount(data);
  const strikes = { values: new Float64Array(count), nulls: new Uint8Array(count) };
  decodeSliceInto(data, kinds.slice(0, 1), [strikes], null, 0);
  for (let index = 0; index < count; index++) if (strikes.values[index]! >= lowestStrike && strikes.values[index]! <= highestStrike) return true;
  return false;
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
export function dayDataTableOfSlices(slices: readonly StoredSlice[], kindsOfLook: (lookMinute: number) => readonly SliceColumnKind[], valueColumns: readonly number[], strings: DayDataStrings, withLookTime: boolean): DayDataTable {
  let rowCount = 0;
  for (const [, data] of slices) rowCount += sliceContractCount(data);
  const lookTimes = withLookTime ? new Int32Array(rowCount) : null;
  const expiries = new Int32Array(rowCount);
  const strikes: SliceNumberColumn = { values: new Float64Array(rowCount), nulls: new Uint8Array(rowCount) };
  const puts = new Uint8Array(rowCount);
  const values = valueColumns.map(() => ({ values: new Float64Array(rowCount), nulls: new Uint8Array(rowCount) }));
  const callIndex = strings.indexOf("C");
  const putIndex = strings.indexOf("P");
  let at = 0;
  for (const [key, data] of slices) {
    const lookMinute = lookMinuteOfKey(key);
    const kinds = kindsOfLook(lookMinute);
    const targets: (SliceNumberColumn | undefined)[] = new Array(kinds.length);
    targets[sliceColumn.strike] = strikes;
    valueColumns.forEach((column, valueIndex) => (targets[column] = values[valueIndex]));
    const count = decodeSliceInto(data, kinds, targets, puts, at);
    if (lookTimes) lookTimes.fill(strings.indexOf(lookTimeOfMinute(lookMinute)), at, at + count);
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
export { quoteWindowDays as sliceQuoteWindowDays, endOfDayWindowDays as sliceEndOfDayWindowDays };
