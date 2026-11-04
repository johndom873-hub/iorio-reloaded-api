import "dotenv/config";
import { openBacktestDataFileReadOnly } from "../src/backtest/backtestDataFile.js";
import { AlphaVantageRefusedError, readFileDividendsFetchedAt, refreshFileDividends } from "../src/backtest/backtestFileDividends.js";
import { normalizeBacktestSymbol } from "../src/backtest/backtestDataDirectory.js";
import { listBacktestDataFileSymbols } from "../src/backtest/dataFileSummary.js";

// The data files' cash dividends from Alpha Vantage (src/backtest/backtestFileDividends.ts): every file, or the symbols
// given; never-fetched files first, then the longest ago, skipping one fetched in the last 30 days unless named. One
// request a ticker, 13 s apart; the free key allows 25 a day, and Alpha Vantage's refusal (its limit, an unknown symbol)
// stops the run with its message: run it again the next day for the rest.
//
// Usage: npm run backtest:fetch-dividends [-- SYMBOL ...]

const pauseBetweenRequestsMilliseconds = 13_000;
const refetchAfterDays = 30;

const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
if (!apiKey) throw new Error("ALPHA_VANTAGE_API_KEY is not set: the free Alpha Vantage key (.env.example).");
const named = process.argv.slice(2).map(normalizeBacktestSymbol);
const fetchedAtOf = (symbol: string) => {
  const database = openBacktestDataFileReadOnly(symbol);
  if (!database) return null;
  try {
    return readFileDividendsFetchedAt(database);
  } catch {
    return null;
  } finally {
    database.close();
  }
};
const now = Date.now();
const candidates = (named.length > 0 ? named : listBacktestDataFileSymbols())
  .map((symbol) => ({ symbol, fetchedAt: fetchedAtOf(symbol) }))
  .filter((entry) => named.length > 0 || entry.fetchedAt === null || now - Date.parse(entry.fetchedAt) > refetchAfterDays * 86_400_000)
  .sort((a, b) => (a.fetchedAt ?? "").localeCompare(b.fetchedAt ?? "") || a.symbol.localeCompare(b.symbol));
console.log(`${candidates.length} file(s) to fetch: ${candidates.map((entry) => entry.symbol).join(", ")}`);
for (const [index, { symbol }] of candidates.entries()) {
  if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, pauseBetweenRequestsMilliseconds));
  try {
    console.log(`${symbol}: ${await refreshFileDividends(symbol, apiKey)} dividends`);
  } catch (error) {
    if (error instanceof AlphaVantageRefusedError) {
      console.log(`${symbol}: Alpha Vantage refused (${error.message}). Stopping; ${candidates.length - index} left for another day.`);
      break;
    }
    console.error(`${symbol}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(0);
