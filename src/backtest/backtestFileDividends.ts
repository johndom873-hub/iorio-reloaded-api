import type { DatabaseSync } from "node:sqlite";
import { openBacktestDataFileForWriting } from "./backtestDataFile.js";

// The cash dividends a data file keeps (Marcelo 2026-11-04): each ex-dividend date and the amount paid per share as
// paid then (not adjusted for later splits), from Alpha Vantage's DIVIDENDS (the whole history, one request a ticker; the
// free key allows 25 requests a day). Node writes them; the downloader never touches this table. A refresh replaces a
// file's dividends whole.

export interface FileDividend {
  exDividendDate: string;
  /** Per share, as paid on that date. */
  amount: number;
}

const createDividendsSql = `
  CREATE TABLE IF NOT EXISTS file_dividends (ex_dividend_date TEXT PRIMARY KEY, amount REAL NOT NULL) WITHOUT ROWID;
`;
const fetchedAtMetaKey = "dividends_fetched_at";

/** The dividends of Alpha Vantage's DIVIDENDS answer: "None" or missing dates and non-positive amounts left out. */
export function dividendsFromAlphaVantage(body: unknown): FileDividend[] {
  const data = (body as { data?: { ex_dividend_date?: string; amount?: string }[] } | null)?.data;
  if (!Array.isArray(data)) {
    const message = (body as Record<string, unknown> | null)?.Information ?? (body as Record<string, unknown> | null)?.Note ?? (body as Record<string, unknown> | null)?.["Error Message"];
    throw new AlphaVantageRefusedError(typeof message === "string" ? message : `Alpha Vantage sent no dividends: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return data
    .filter((row) => typeof row.ex_dividend_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.ex_dividend_date) && Number(row.amount) > 0)
    .map((row) => ({ exDividendDate: row.ex_dividend_date!, amount: Number(row.amount) }))
    .sort((a, b) => a.exDividendDate.localeCompare(b.exDividendDate));
}

/** Alpha Vantage answered without data: its daily limit, a bad key or an unknown symbol (its own message). */
export class AlphaVantageRefusedError extends Error {}

/** A ticker's dividends from Alpha Vantage (one request). */
export async function fetchAlphaVantageDividends(symbol: string, apiKey: string): Promise<FileDividend[]> {
  const response = await fetch(`https://www.alphavantage.co/query?function=DIVIDENDS&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`);
  if (!response.ok) throw new Error(`Alpha Vantage answered ${response.status} for ${symbol}.`);
  try {
    return dividendsFromAlphaVantage(await response.json());
  } catch (error) {
    // Its limit message quotes the key: kept out of the logs.
    if (error instanceof AlphaVantageRefusedError) throw new AlphaVantageRefusedError(error.message.replaceAll(apiKey, "<key>"));
    throw error;
  }
}

/** Replaces the file's dividends with `dividends` and records when, in one transaction. */
export function writeFileDividends(database: DatabaseSync, dividends: readonly FileDividend[], fetchedAt: Date): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(createDividendsSql);
    database.exec("DELETE FROM file_dividends");
    const insert = database.prepare("INSERT INTO file_dividends (ex_dividend_date, amount) VALUES (?, ?)");
    for (const dividend of dividends) insert.run(dividend.exDividendDate, dividend.amount);
    database.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(fetchedAtMetaKey, fetchedAt.toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** The file's dividends, oldest first; null when they were never fetched. */
export function readFileDividends(database: DatabaseSync): FileDividend[] | null {
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_dividends'").get() === undefined) return null;
  return database.prepare("SELECT ex_dividend_date AS exDividendDate, amount FROM file_dividends ORDER BY ex_dividend_date").all() as unknown as FileDividend[];
}

/** When the file's dividends were last fetched; null when never. */
export function readFileDividendsFetchedAt(database: DatabaseSync): string | null {
  return (database.prepare("SELECT value FROM meta WHERE key = ?").get(fetchedAtMetaKey) as { value: string } | undefined)?.value ?? null;
}

/** Fetches a ticker's dividends and writes them into its data file; the count written. */
export async function refreshFileDividends(symbol: string, apiKey: string, now = new Date()): Promise<number> {
  const dividends = await fetchAlphaVantageDividends(symbol, apiKey);
  const database = openBacktestDataFileForWriting(symbol);
  if (!database) throw new Error(`No data file for ${symbol}: download it first.`);
  try {
    writeFileDividends(database, dividends, now);
  } finally {
    database.close();
  }
  return dividends.length;
}
