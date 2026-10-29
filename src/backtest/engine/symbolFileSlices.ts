import { easternInstant } from "../../lib/easternIsoDate.js";

// Schema 4 of the symbol files (docs/backtesting/DATA-FILES.md): a day's option rows stored as slices, one SQLite row
// per day, look and expiry, its contracts packed as columns in strike order (the Call before the Put), each column in
// the narrowest width its values need within the slice. BacktestSymbolFile and the day-data reader threads read them;
// the downloader and the schema 3 conversion write them.
//
// A slice's bytes (little-endian): u32 contract count, then each column in order:
// - the right: a bitmap (bit set = Put), padded to 4 bytes;
// - a number: a descriptor byte (bits 0-2 the width: 0 none, every value = base; 1 u8; 2 u16; 3 i32; 4 the stored
//   numbers as f64, NaN for null; bit 3 a null bitmap follows; bit 4 stored as the difference from the column before
//   it), 3 padding bytes, i32 base, i32 step, [the null bitmap padded to 4], then the values, padded to 4 bytes (f64
//   starts on 8). A value = base + stored × step [+ the column before's value], in the column's unit: thousandths of a
//   dollar for strikes, cents for prices, counts for sizes, volumes, open interest and milliseconds. A slice whose
//   values are not exact in the unit keeps that column as f64.

/** The 10:00 quotes' look, in minutes after midnight Eastern; each later look is its own minute (10:30 = 630). */
export const tenOClockLookMinute = 600;

/** The look minute of the end-of-day and open-interest slices' keys. */
export const dailySliceLookMinute = 0;

/** A slice's key: the trading day (days since 1970-01-01), the look's minute and the calendar days from the trading day to the expiry. */
export function sliceKey(dayNumber: number, lookMinute: number, daysToExpiry: number): number {
  return dayNumber * 4_294_967_296 + lookMinute * 65_536 + daysToExpiry;
}

export const dayNumberOfKey = (key: number): number => Math.floor(key / 4_294_967_296);
export const lookMinuteOfKey = (key: number): number => Math.floor(key / 65_536) % 65_536;
export const daysToExpiryOfKey = (key: number): number => key % 65_536;

/** Days since 1970-01-01 of a YYYY-MM-DD date. */
export const dayNumberOf = (isoDate: string): number => Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000;

const isoDateByDayNumber = new Map<number, string>();

/** The YYYY-MM-DD date of a day number. */
export function isoDateOfDayNumber(dayNumber: number): string {
  let isoDate = isoDateByDayNumber.get(dayNumber);
  if (isoDate === undefined) {
    isoDate = new Date(dayNumber * 86_400_000).toISOString().slice(0, 10);
    isoDateByDayNumber.set(dayNumber, isoDate);
  }
  return isoDate;
}

/** The minute of an "HH:MM" Eastern look time. */
export const lookMinuteOf = (lookTime: string): number => Number(lookTime.slice(0, 2)) * 60 + Number(lookTime.slice(3, 5));

/** The "HH:MM" look time of a minute. */
export const lookTimeOfMinute = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export type SliceColumnKind = "strike" | "right" | "cents" | "centsOverPrevious" | "count";

/** The 10:00 quotes: strike, right, bid, ask, bid size, ask size, and the milliseconds from the quote's own time to 10:00 (quoted_at). */
export const tenOClockQuoteColumns: readonly SliceColumnKind[] = ["strike", "right", "cents", "centsOverPrevious", "count", "count", "count"];
/** A later look's quotes: strike, right, bid, ask, bid size, ask size. */
export const laterLookQuoteColumns: readonly SliceColumnKind[] = ["strike", "right", "cents", "centsOverPrevious", "count", "count"];
/** The end of day: strike, right, close, volume, the closing bid and ask. */
export const endOfDayColumns: readonly SliceColumnKind[] = ["strike", "right", "cents", "count", "cents", "centsOverPrevious"];
/** The open interest: strike, right, open interest. */
export const openInterestColumns: readonly SliceColumnKind[] = ["strike", "right", "count"];

export const quoteColumnsOfLook = (lookMinute: number): readonly SliceColumnKind[] => (lookMinute === tenOClockLookMinute ? tenOClockQuoteColumns : laterLookQuoteColumns);

/** Column positions in the quote, end-of-day and open-interest slices. */
export const sliceColumn = { strike: 0, right: 1, bid: 2, ask: 3, bidSize: 4, askSize: 5, millisecondsBeforeTen: 6, close: 2, volume: 3, endOfDayBid: 4, endOfDayAsk: 5, openInterest: 2 } as const;

export const schemaFourSliceTablesSql = `
  CREATE TABLE option_quote_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL, has_ask_above_zero INTEGER NOT NULL, data BLOB NOT NULL);
  CREATE TABLE end_of_day_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL, has_volume INTEGER NOT NULL, data BLOB NOT NULL);
  CREATE TABLE open_interest_slices (key INTEGER PRIMARY KEY, call_count INTEGER NOT NULL, put_count INTEGER NOT NULL, data BLOB NOT NULL);
`;

const unitOf: Record<Exclude<SliceColumnKind, "right">, number> = { strike: 1000, cents: 100, centsOverPrevious: 100, count: 1 };
const widthBytes = [0, 1, 2, 4, 8] as const;
const paddedTo = (bytes: number, alignment: number): number => Math.ceil(bytes / alignment) * alignment;
const bitmapBytesOf = (count: number): number => paddedTo(Math.ceil(count / 8), 4);
const greatestCommonDivisor = (a: number, b: number): number => {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
};

/** A contract's values in the columns' order: the right as "C" or "P", the others numbers or null. */
export type SliceRow = readonly (number | string | null)[];

/** Packs contracts (in strike order, the Call before the Put) into a slice's bytes. */
export function packSlice(rows: readonly SliceRow[], kinds: readonly SliceColumnKind[]): Uint8Array {
  const count = rows.length;
  const parts: Uint8Array[] = [];
  let size = 4;
  let previousUnits: Int32Array | null = null;
  kinds.forEach((kind, column) => {
    if (kind === "right") {
      const bitmap = new Uint8Array(bitmapBytesOf(count));
      rows.forEach((row, index) => {
        if (row[column] === "P") bitmap[index >> 3] = bitmap[index >> 3]! | (1 << (index & 7));
        else if (row[column] !== "C") throw new Error(`right ${String(row[column])}`);
      });
      parts.push(bitmap);
      size += bitmap.length;
      previousUnits = null;
      return;
    }
    const unit = unitOf[kind];
    const units = new Int32Array(count);
    const nulls = new Uint8Array(bitmapBytesOf(count));
    let hasNulls = false;
    let exact = true;
    rows.forEach((row, index) => {
      const value = row[column];
      if (value === null) {
        hasNulls = true;
        nulls[index >> 3] = nulls[index >> 3]! | (1 << (index & 7));
        return;
      }
      if (typeof value !== "number") throw new Error(`column ${column}: ${typeof value}`);
      const scaled = Math.round(value * unit);
      if (scaled / unit !== value || scaled <= -2_147_483_648 || scaled > 2_147_483_647) exact = false;
      units[index] = scaled;
    });
    if (!exact) {
      const descriptor = new Uint8Array(12);
      descriptor[0] = 4;
      const padding = new Uint8Array(paddedTo(size + 12, 8) - (size + 12));
      const values = new Float64Array(count);
      rows.forEach((row, index) => (values[index] = row[column] === null ? Number.NaN : (row[column] as number)));
      parts.push(descriptor, padding, new Uint8Array(values.buffer));
      size += 12 + padding.length + values.byteLength;
      previousUnits = null;
      return;
    }
    // The ask as its spread over the bid, when the bid is in cents and present wherever the ask is.
    let stored = units;
    let overPrevious = false;
    const previous: Int32Array | null = previousUnits;
    if (kind === "centsOverPrevious" && previous !== null && rows.every((row) => row[column] === null || row[column - 1] !== null)) {
      stored = new Int32Array(count);
      for (let index = 0; index < count; index++) stored[index] = rows[index]![column] === null ? 0 : units[index]! - previous[index]!;
      overPrevious = true;
    }
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < count; index++) {
      if (rows[index]![column] === null) continue;
      minimum = Math.min(minimum, stored[index]!);
      maximum = Math.max(maximum, stored[index]!);
    }
    if (minimum === Number.POSITIVE_INFINITY) minimum = maximum = 0;
    let step = 1;
    if (kind === "strike") {
      step = 0;
      for (let index = 0; index < count; index++) if (rows[index]![column] !== null) step = greatestCommonDivisor(step, stored[index]! - minimum);
      if (step === 0) step = 1;
    }
    const range = (maximum - minimum) / step;
    const widthCode = range === 0 ? 0 : range <= 0xff ? 1 : range <= 0xffff ? 2 : 3;
    const descriptor = new Uint8Array(12);
    descriptor[0] = widthCode | (hasNulls ? 8 : 0) | (overPrevious ? 16 : 0);
    const descriptorView = new DataView(descriptor.buffer);
    descriptorView.setInt32(4, minimum, true);
    descriptorView.setInt32(8, step, true);
    parts.push(descriptor);
    size += 12;
    if (hasNulls) {
      parts.push(nulls);
      size += nulls.length;
    }
    if (widthCode > 0) {
      const bytes = widthBytes[widthCode]!;
      const values = widthCode === 1 ? new Uint8Array(paddedTo(count, 4)) : widthCode === 2 ? new Uint16Array(paddedTo(count * 2, 4) / 2) : new Int32Array(count);
      for (let index = 0; index < count; index++) values[index] = rows[index]![column] === null ? 0 : (stored[index]! - minimum) / step;
      parts.push(new Uint8Array(values.buffer, 0, paddedTo(count * bytes, 4)));
      size += paddedTo(count * bytes, 4);
    }
    previousUnits = units;
  });
  const slice = new Uint8Array(size);
  new DataView(slice.buffer).setUint32(0, count, true);
  let at = 4;
  for (const part of parts) {
    slice.set(part, at);
    at += part.length;
  }
  return slice;
}

/** A decoded number column: the values, and 1 where a value is null. */
export interface SliceNumberColumn {
  values: Float64Array;
  nulls: Uint8Array;
}

/** The number of contracts in a slice. */
export const sliceContractCount = (bytes: Uint8Array): number => new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);

/**
 * Decodes a slice into arrays from position `at`: each number column into `targets[column]` (skipped when undefined),
 * values in dollars or counts, and the rights into `puts` (1 = Put; skipped when null). Returns the contract count.
 */
export function decodeSliceInto(bytes: Uint8Array, kinds: readonly SliceColumnKind[], targets: readonly (SliceNumberColumn | undefined)[], puts: Uint8Array | null, at: number): number {
  const aligned = bytes.byteOffset % 8 === 0 ? bytes : new Uint8Array(bytes);
  const view = new DataView(aligned.buffer, aligned.byteOffset, aligned.byteLength);
  const count = view.getUint32(0, true);
  const bitmapBytes = bitmapBytesOf(count);
  let offset = 4;
  let previousUnits: Int32Array | null = null;
  for (let column = 0; column < kinds.length; column++) {
    const kind = kinds[column]!;
    if (kind === "right") {
      if (puts) for (let index = 0; index < count; index++) puts[at + index] = (aligned[offset + (index >> 3)]! >> (index & 7)) & 1;
      offset += bitmapBytes;
      previousUnits = null;
      continue;
    }
    const target = targets[column];
    const descriptor = aligned[offset]!;
    const widthCode = descriptor & 7;
    if (widthCode === 4) {
      offset = paddedTo(offset + 12, 8);
      const values = new Float64Array(aligned.buffer, aligned.byteOffset + offset, count);
      if (target) {
        for (let index = 0; index < count; index++) {
          const value = values[index]!;
          if (Number.isNaN(value)) target.nulls[at + index] = 1;
          else target.values[at + index] = value;
        }
      }
      offset += count * 8;
      previousUnits = null;
      continue;
    }
    const base = view.getInt32(offset + 4, true);
    const step = view.getInt32(offset + 8, true);
    offset += 12;
    let nullBits: Uint8Array | null = null;
    if (descriptor & 8) {
      nullBits = new Uint8Array(aligned.buffer, aligned.byteOffset + offset, bitmapBytes);
      offset += bitmapBytes;
    }
    let stored: Uint8Array | Uint16Array | Int32Array | null = null;
    if (widthCode > 0) {
      const start = aligned.byteOffset + offset;
      stored = widthCode === 1 ? new Uint8Array(aligned.buffer, start, count) : widthCode === 2 ? new Uint16Array(aligned.buffer, start, count) : new Int32Array(aligned.buffer, start, count);
      offset += paddedTo(count * widthBytes[widthCode]!, 4);
    }
    const overPrevious = (descriptor & 16) !== 0;
    if (overPrevious && previousUnits === null) throw new Error(`column ${column} is stored over a column without units`);
    // The next column may be stored as its difference from this one.
    const units = kinds[column + 1] === "centsOverPrevious" ? new Int32Array(count) : null;
    const unit = unitOf[kind];
    for (let index = 0; index < count; index++) {
      if (nullBits !== null && (nullBits[index >> 3]! >> (index & 7)) & 1) {
        if (target) target.nulls[at + index] = 1;
        continue;
      }
      let value = base + (stored === null ? 0 : stored[index]! * step);
      if (overPrevious) value += previousUnits![index]!;
      if (units) units[index] = value;
      if (target) target.values[at + index] = unit === 1 ? value : value / unit;
    }
    previousUnits = units;
  }
  return count;
}

/** A slice's columns in arrays of their own: `columns[column]` for each number column (null for the right), and the rights. */
export function decodeSlice(bytes: Uint8Array, kinds: readonly SliceColumnKind[]): { count: number; puts: Uint8Array; columns: (SliceNumberColumn | null)[] } {
  const count = sliceContractCount(bytes);
  const columns = kinds.map((kind) => (kind === "right" ? null : { values: new Float64Array(count), nulls: new Uint8Array(count) }));
  const puts = new Uint8Array(count);
  decodeSliceInto(bytes, kinds, columns.map((column) => column ?? undefined), puts, 0);
  return { count, puts, columns };
}

/** A decoded column's value at a contract: a number, or null. */
export const sliceValueAt = (column: SliceNumberColumn, index: number): number | null => (column.nulls[index] === 1 ? null : column.values[index]!);

/** The flags of a slice row: its Calls and Puts, and whether any contract has an ask above 0 (quotes) or a volume (end of day). */
export function sliceRowFlags(rows: readonly SliceRow[], flagColumn: number, flag: "askAboveZero" | "volume"): { callCount: number; putCount: number; flagged: boolean } {
  let callCount = 0;
  let flagged = false;
  for (const row of rows) {
    if (row[sliceColumn.right] === "C") callCount++;
    const value = row[flagColumn];
    if (flag === "askAboveZero" ? typeof value === "number" && value > 0 : value !== null) flagged = true;
  }
  return { callCount, putCount: rows.length - callCount, flagged };
}

/** Milliseconds from a quote's own time (ISO with offset) to 10:00:00 Eastern on the trading date: what a 10:00 slice keeps of quoted_at. */
export function millisecondsBeforeTenOClock(tradingDate: string, quotedAtIso: string): number {
  const quotedAtMs = Date.parse(quotedAtIso);
  if (Number.isNaN(quotedAtMs)) throw new Error(`quoted_at ${quotedAtIso} is not a time`);
  return easternInstant(tradingDate, 10, 0).getTime() - quotedAtMs;
}

/** The quote's own time from a 10:00 slice's milliseconds before 10:00. */
export const quotedAtOf = (tradingDate: string, millisecondsBeforeTen: number): Date => new Date(easternInstant(tradingDate, 10, 0).getTime() - millisecondsBeforeTen);
