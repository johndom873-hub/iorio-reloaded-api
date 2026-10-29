import { statSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { formatEasternIsoWithOffset } from "../lib/easternIsoDate.js";
import {
  dailySliceLookMinute,
  dayNumberOf,
  daysToExpiryOfKey,
  decodeSlice,
  endOfDayColumns,
  isoDateOfDayNumber,
  lookMinuteOf,
  lookMinuteOfKey,
  lookTimeOfMinute,
  millisecondsBeforeTenOClock,
  openInterestColumns,
  packSlice,
  quoteColumnsOfLook,
  quotedAtOf,
  schemaFourSliceTablesSql,
  sliceColumn,
  sliceKey,
  sliceRowFlags,
  sliceValueAt,
  tenOClockLookMinute,
  type SliceColumnKind,
  type SliceRow,
} from "./engine/symbolFileSlices.js";

// Converting a schema 3 symbol file to schema 4 (docs/backtesting/DATA-FILES.md, Marcelo 2026-10-29), and the check
// that the new file holds every value the old one did. The option tables become slices; every other table and meta key
// is copied as it is (schema_version becomes "4"). The intraday quotes at 10:00 are left out: the 10:00 quotes hold the
// same values, which the conversion checks row for row before writing anything.

/** The tables schema 4 stores as slices. */
const optionTables = new Set(["quotes", "eod", "open_interest", "intraday_quotes"]);

/** Writes the schema 4 copy of `sourcePath` at `targetPath` (which must not exist). */
export function convertSymbolFileToSchemaFour(sourcePath: string, targetPath: string): void {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const version = (source.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
    if (version !== "3") throw new Error(`${sourcePath} has schema version ${version ?? "unknown"}; only version 3 files are converted.`);
    const unexpected = source.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger')").all() as { type: string; name: string }[];
    if (unexpected.length > 0) throw new Error(`${sourcePath} has ${unexpected.map((entry) => `${entry.type} ${entry.name}`).join(", ")}, which the conversion does not carry.`);
    const differingTenOClockRows = Number(
      (
        source
          .prepare(
            `SELECT count(*) AS count FROM intraday_quotes i LEFT JOIN quotes q ON q.trading_date = i.trading_date AND q.expiry = i.expiry AND q.strike = i.strike AND q.option_right = i.option_right
             WHERE i.look_time = '10:00' AND (q.trading_date IS NULL OR q.bid IS NOT i.bid OR q.ask IS NOT i.ask OR q.bid_size IS NOT i.bid_size OR q.ask_size IS NOT i.ask_size OR i.quoted_at IS NOT NULL)`,
          )
          .get() as { count: number }
      ).count,
    );
    if (differingTenOClockRows > 0) throw new Error(`${sourcePath}: ${differingTenOClockRows} intraday quotes at 10:00 differ from the 10:00 quotes; not converted.`);
  } finally {
    source.close();
  }

  const target = new DatabaseSync(targetPath);
  let inTransaction = false;
  try {
    target.exec("PRAGMA page_size = 16384");
    target.prepare("ATTACH DATABASE ? AS source").run(sourcePath);
    target.exec("BEGIN");
    inTransaction = true;
    // Every other table, with its indexes, row for row (rowid tables keep their rowids).
    const tables = target.prepare("SELECT name, sql FROM source.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
    for (const { name, sql } of tables) {
      if (optionTables.has(name)) continue;
      target.exec(sql);
      const columns = (target.prepare(`SELECT name FROM pragma_table_info(?, 'source')`).all(name) as { name: string }[]).map((column) => `"${column.name}"`).join(", ");
      const keepsRowids = !/WITHOUT\s+ROWID/i.test(sql);
      target.exec(`INSERT INTO main."${name}" (${keepsRowids ? "rowid, " : ""}${columns}) SELECT ${keepsRowids ? "rowid, " : ""}${columns} FROM source."${name}"`);
    }
    for (const { sql } of target.prepare("SELECT sql FROM source.sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { sql: string }[]) target.exec(sql);
    target.exec("UPDATE main.meta SET value = '4' WHERE key = 'schema_version'");

    target.exec(schemaFourSliceTablesSql);
    const insertQuoteSlice = target.prepare("INSERT INTO main.option_quote_slices (key, call_count, put_count, has_ask_above_zero, data) VALUES (?, ?, ?, ?, ?)");
    const insertEndOfDaySlice = target.prepare("INSERT INTO main.end_of_day_slices (key, call_count, put_count, has_volume, data) VALUES (?, ?, ?, ?, ?)");
    const insertOpenInterestSlice = target.prepare("INSERT INTO main.open_interest_slices (key, call_count, put_count, data) VALUES (?, ?, ?, ?)");
    const arrays = (sql: string): StatementSync => {
      const statement = target.prepare(sql);
      statement.setReturnArrays(true);
      return statement;
    };
    const tenOClockRowsOfDay = arrays("SELECT expiry, strike, option_right, bid, ask, bid_size, ask_size, quoted_at FROM source.quotes WHERE trading_date = ? ORDER BY expiry, strike, option_right");
    const laterLookRowsOfDay = arrays("SELECT look_time, expiry, strike, option_right, bid, ask, bid_size, ask_size, quoted_at FROM source.intraday_quotes WHERE trading_date = ? AND look_time > '10:00' ORDER BY look_time, expiry, strike, option_right");
    const endOfDayRowsOfDay = arrays("SELECT expiry, strike, option_right, close, volume, bid, ask FROM source.eod WHERE trading_date = ? ORDER BY expiry, strike, option_right");
    const openInterestRowsOfDay = arrays("SELECT expiry, strike, option_right, open_interest FROM source.open_interest WHERE trading_date = ? ORDER BY expiry, strike, option_right");
    const tradingDates = (target.prepare("SELECT trading_date FROM source.days ORDER BY trading_date").all() as { trading_date: string }[]).map((row) => row.trading_date);
    for (const tradingDate of tradingDates) {
      const dayNumber = dayNumberOf(tradingDate);
      // Each day's slices in key order: the 10:00 quotes, then each later look, each by expiry.
      const groups = new Map<number, SliceRow[]>();
      const add = (key: number, row: SliceRow) => {
        const rows = groups.get(key);
        if (rows) rows.push(row);
        else groups.set(key, [row]);
      };
      for (const [expiry, strike, right, bid, ask, bidSize, askSize, quotedAt] of tenOClockRowsOfDay.all(tradingDate) as unknown as [string, number, string, number | null, number | null, number | null, number | null, string | null][]) {
        add(sliceKey(dayNumber, tenOClockLookMinute, dayNumberOf(expiry) - dayNumber), [strike, right, bid, ask, bidSize, askSize, quotedAt === null ? null : millisecondsBeforeTenOClock(tradingDate, quotedAt)]);
      }
      for (const [lookTime, expiry, strike, right, bid, ask, bidSize, askSize, quotedAt] of laterLookRowsOfDay.all(tradingDate) as unknown as [string, string, number, string, number | null, number | null, number | null, number | null, string | null][]) {
        if (quotedAt !== null) throw new Error(`${sourcePath}: an intraday quote on ${tradingDate} at ${lookTime} has a quoted_at, which schema 4 does not keep for later looks.`);
        add(sliceKey(dayNumber, lookMinuteOf(lookTime), dayNumberOf(expiry) - dayNumber), [strike, right, bid, ask, bidSize, askSize]);
      }
      for (const [key, rows] of [...groups.entries()].sort(([a], [b]) => a - b)) {
        const flags = sliceRowFlags(rows, sliceColumn.ask, "askAboveZero");
        insertQuoteSlice.run(key, flags.callCount, flags.putCount, flags.flagged ? 1 : 0, packSlice(rows, quoteColumnsOfLook(lookMinuteOfKey(key))));
      }
      for (const [key, rows] of groupByExpiry(endOfDayRowsOfDay.all(tradingDate) as unknown as unknown[][], dayNumber)) {
        const flags = sliceRowFlags(rows, sliceColumn.volume, "volume");
        insertEndOfDaySlice.run(key, flags.callCount, flags.putCount, flags.flagged ? 1 : 0, packSlice(rows, endOfDayColumns));
      }
      for (const [key, rows] of groupByExpiry(openInterestRowsOfDay.all(tradingDate) as unknown as unknown[][], dayNumber)) {
        const flags = sliceRowFlags(rows, sliceColumn.openInterest, "volume");
        insertOpenInterestSlice.run(key, flags.callCount, flags.putCount, packSlice(rows, openInterestColumns));
      }
    }
    target.exec("COMMIT");
    inTransaction = false;
    target.exec("DETACH DATABASE source");
  } catch (error) {
    if (inTransaction) target.exec("ROLLBACK");
    throw error;
  } finally {
    target.close();
  }
}

/** End-of-day or open-interest rows (expiry first, then the slice's columns) grouped into slices by expiry, in key order. */
function groupByExpiry(rows: readonly unknown[][], dayNumber: number): [number, SliceRow[]][] {
  const groups: [number, SliceRow[]][] = [];
  let currentExpiry: string | null = null;
  for (const [expiry, ...values] of rows) {
    if (expiry !== currentExpiry) {
      currentExpiry = expiry as string;
      groups.push([sliceKey(dayNumber, dailySliceLookMinute, dayNumberOf(currentExpiry) - dayNumber), []]);
    }
    groups.at(-1)![1].push(values as SliceRow);
  }
  return groups;
}

/** A slice row as the check reads it. */
interface StoredSlice {
  key: number;
  callCount: number;
  putCount: number;
  flagged: number;
  data: Uint8Array;
}

export interface SchemaFourCheck {
  /** Rows compared in the option tables (the intraday quotes after 10:00 only) and in every other table. */
  optionRows: number;
  otherRows: number;
  sourceBytes: number;
  targetBytes: number;
}

/**
 * Proves the schema 4 file at `targetPath` holds every value of the schema 3 file at `sourcePath`: each option table's
 * rows, in their order, from the slices (quoted_at back to its exact text); each slice's counts and flags; every other
 * table row for row with its rowids; every meta key (schema_version "3" → "4"); and SQLite's integrity check. Throws on
 * the first difference.
 */
export function checkSchemaFourFile(sourcePath: string, targetPath: string): SchemaFourCheck {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new DatabaseSync(targetPath, { readOnly: true });
  try {
    const integrity = (target.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((row) => row.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== "ok") throw new Error(`${targetPath}: integrity check says ${integrity.join("; ")}`);
    const targetVersion = (target.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
    if (targetVersion !== "4") throw new Error(`${targetPath} has schema version ${targetVersion ?? "unknown"}, not 4.`);

    let otherRows = 0;
    const tables = source.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
    for (const { name, sql } of tables) {
      if (optionTables.has(name)) continue;
      const columns = (source.prepare("SELECT name FROM pragma_table_info(?)").all(name) as { name: string }[]).map((column) => `"${column.name}"`);
      const keepsRowids = !/WITHOUT\s+ROWID/i.test(sql);
      const selected = `${keepsRowids ? "rowid, " : ""}${columns.join(", ")}`;
      const orderedSql = `SELECT ${selected} FROM "${name}" ORDER BY ${keepsRowids ? "rowid" : columns.join(", ")}`;
      const sourceRows = source.prepare(orderedSql);
      const targetRows = target.prepare(orderedSql);
      sourceRows.setReturnArrays(true);
      targetRows.setReturnArrays(true);
      const targetIterator = targetRows.iterate();
      for (const sourceRow of sourceRows.iterate() as Iterable<unknown[]>) {
        const next = targetIterator.next();
        let targetRow = next.done ? null : (next.value as unknown as unknown[]);
        if (name === "meta" && sourceRow[keepsRowids ? 1 : 0] === "schema_version" && targetRow !== null) targetRow = targetRow.map((value) => (value === "4" ? "3" : value));
        if (targetRow === null || !sameValues(sourceRow, targetRow)) throw new Error(`${targetPath}: table ${name} differs at ${JSON.stringify(sourceRow)} (copy: ${JSON.stringify(targetRow)})`);
        otherRows++;
      }
      if (!targetIterator.next().done) throw new Error(`${targetPath}: table ${name} has more rows than the original`);
    }

    let optionRows = 0;
    const arrays = (database: DatabaseSync, sql: string): StatementSync => {
      const statement = database.prepare(sql);
      statement.setReturnArrays(true);
      return statement;
    };
    const tenOClockRowsOfDay = arrays(source, "SELECT expiry, strike, option_right, bid, ask, bid_size, ask_size, quoted_at FROM quotes WHERE trading_date = ? ORDER BY expiry, strike, option_right");
    const laterLookRowsOfDay = arrays(source, "SELECT look_time, expiry, strike, option_right, bid, ask, bid_size, ask_size, quoted_at FROM intraday_quotes WHERE trading_date = ? AND look_time > '10:00' ORDER BY look_time, expiry, strike, option_right");
    const endOfDayRowsOfDay = arrays(source, "SELECT expiry, strike, option_right, close, volume, bid, ask FROM eod WHERE trading_date = ? ORDER BY expiry, strike, option_right");
    const openInterestRowsOfDay = arrays(source, "SELECT expiry, strike, option_right, open_interest FROM open_interest WHERE trading_date = ? ORDER BY expiry, strike, option_right");
    const slicesOfDay = (table: string) => target.prepare(`SELECT key, call_count AS callCount, put_count AS putCount, ${table === "open_interest_slices" ? "0 AS flagged" : table === "end_of_day_slices" ? "has_volume AS flagged" : "has_ask_above_zero AS flagged"}, data FROM ${table} WHERE key BETWEEN ? AND ? ORDER BY key`);
    const quoteSlicesOfDay = slicesOfDay("option_quote_slices");
    const endOfDaySlicesOfDay = slicesOfDay("end_of_day_slices");
    const openInterestSlicesOfDay = slicesOfDay("open_interest_slices");
    const tradingDates = (source.prepare("SELECT trading_date FROM days ORDER BY trading_date").all() as { trading_date: string }[]).map((row) => row.trading_date);

    /** The rows a day's slices hold, as [look minute, expiry, ...the slice's columns], checking each slice's counts and flag. */
    const rowsOfSlices = (slices: readonly StoredSlice[], tradingDate: string, kindsOf: (lookMinute: number) => readonly SliceColumnKind[], flagOf: (row: readonly unknown[]) => boolean): unknown[][] => {
      const rows: unknown[][] = [];
      const dayNumber = dayNumberOf(tradingDate);
      for (const slice of slices) {
        const lookMinute = lookMinuteOfKey(slice.key);
        const kinds = kindsOf(lookMinute);
        const decoded = decodeSlice(slice.data, kinds);
        const expiry = isoDateOfDayNumber(dayNumber + daysToExpiryOfKey(slice.key));
        let calls = 0;
        let flagged = false;
        for (let index = 0; index < decoded.count; index++) {
          const right = decoded.puts[index] === 1 ? "P" : "C";
          if (right === "C") calls++;
          const values = kinds.map((kind, column) => (kind === "right" ? right : sliceValueAt(decoded.columns[column]!, index)));
          if (flagOf(values)) flagged = true;
          rows.push([lookMinute, expiry, ...values]);
        }
        if (calls !== slice.callCount || decoded.count - calls !== slice.putCount || flagged !== (slice.flagged === 1)) throw new Error(`${targetPath}: slice ${slice.key} of ${tradingDate} has wrong counts or flag`);
      }
      return rows;
    };
    const compareRows = (table: string, tradingDate: string, sourceRows: readonly unknown[][], targetRows: readonly unknown[][]) => {
      if (sourceRows.length !== targetRows.length) throw new Error(`${targetPath}: ${table} on ${tradingDate} has ${targetRows.length} rows, the original ${sourceRows.length}`);
      sourceRows.forEach((sourceRow, index) => {
        if (!sameValues(sourceRow, targetRows[index]!)) throw new Error(`${targetPath}: ${table} on ${tradingDate} differs at ${JSON.stringify(sourceRow)} (copy: ${JSON.stringify(targetRows[index])})`);
      });
      optionRows += sourceRows.length;
    };
    for (const tradingDate of tradingDates) {
      const dayNumber = dayNumberOf(tradingDate);
      const dayStart = sliceKey(dayNumber, 0, 0);
      const dayEnd = sliceKey(dayNumber + 1, 0, 0) - 1;
      const quoteRows = rowsOfSlices(quoteSlicesOfDay.all(dayStart, dayEnd) as unknown as StoredSlice[], tradingDate, quoteColumnsOfLook, (row) => typeof row[sliceColumn.ask] === "number" && (row[sliceColumn.ask] as number) > 0);
      const tenOClockCopy = quoteRows.filter((row) => row[0] === tenOClockLookMinute).map(([, expiry, strike, right, bid, ask, bidSize, askSize, millisecondsBeforeTen]) => [expiry, strike, right, bid, ask, bidSize, askSize, millisecondsBeforeTen === null ? null : formatEasternIsoWithOffset(quotedAtOf(tradingDate, millisecondsBeforeTen as number))]);
      compareRows("quotes", tradingDate, tenOClockRowsOfDay.all(tradingDate) as unknown as unknown[][], tenOClockCopy);
      const laterCopy = quoteRows.filter((row) => row[0] !== tenOClockLookMinute).map(([lookMinute, ...rest]) => [lookTimeOfMinute(lookMinute as number), ...rest, null]);
      compareRows("intraday_quotes", tradingDate, laterLookRowsOfDay.all(tradingDate) as unknown as unknown[][], laterCopy);
      const endOfDayCopy = rowsOfSlices(endOfDaySlicesOfDay.all(dayStart, dayEnd) as unknown as StoredSlice[], tradingDate, () => endOfDayColumns, (row) => row[sliceColumn.volume] !== null).map(([, ...rest]) => rest);
      compareRows("eod", tradingDate, endOfDayRowsOfDay.all(tradingDate) as unknown as unknown[][], endOfDayCopy);
      const openInterestCopy = rowsOfSlices(openInterestSlicesOfDay.all(dayStart, dayEnd) as unknown as StoredSlice[], tradingDate, () => openInterestColumns, () => false).map(([, ...rest]) => rest);
      compareRows("open_interest", tradingDate, openInterestRowsOfDay.all(tradingDate) as unknown as unknown[][], openInterestCopy);
    }
    // Rows on a date without a `days` row would be missed above: the totals must match too.
    const sourceTotal = Number((source.prepare("SELECT (SELECT count(*) FROM quotes) + (SELECT count(*) FROM intraday_quotes WHERE look_time > '10:00') + (SELECT count(*) FROM eod) + (SELECT count(*) FROM open_interest) AS count").get() as { count: number }).count);
    if (sourceTotal !== optionRows) throw new Error(`${targetPath}: the original holds ${sourceTotal} option rows, the days compared ${optionRows}`);
    const sliceTotal = Number((target.prepare("SELECT (SELECT coalesce(sum(call_count + put_count), 0) FROM option_quote_slices) + (SELECT coalesce(sum(call_count + put_count), 0) FROM end_of_day_slices) + (SELECT coalesce(sum(call_count + put_count), 0) FROM open_interest_slices) AS count").get() as { count: number }).count);
    if (sliceTotal !== optionRows) throw new Error(`${targetPath}: the slices hold ${sliceTotal} contracts, the original ${optionRows} option rows`);
    return { optionRows, otherRows, sourceBytes: statSync(sourcePath).size, targetBytes: statSync(targetPath).size };
  } finally {
    source.close();
    target.close();
  }
}

/** Equal values, element by element: the same numbers, strings, nulls and bytes. */
function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index];
    const right = b[index];
    if (left instanceof Uint8Array && right instanceof Uint8Array) {
      if (left.length !== right.length || left.some((byte, at) => byte !== right[at])) return false;
    } else if (left !== right) return false;
  }
  return true;
}
