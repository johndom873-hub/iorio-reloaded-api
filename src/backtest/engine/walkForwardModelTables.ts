import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { isEtfSector } from "../../lib/tickerCalendarRelevance.js";
import { buildVolatilityModelTables, type TickerHistoryInput } from "../../lib/volatilityModelTablesBuilder.js";
import { volatilityModelTables as currentVolatilityModelTables } from "../../lib/volatilityModelTables.generated.js";
import type { VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import type { BacktestTablesMode } from "../backtestTypes.js";

// The valuation model's tables a session day is valued with (docs/backtesting/FORMULAS.md, "Model history tables").
// "current": the committed generated module. "walk_forward": for a day in year Y, tables built exactly as
// scripts/build-volatility-model-tables.ts builds them (same options, every ticker's bars, IBKR implied volatility and
// earnings in the local DB) but only from data dated before 1 January of Y. Each year's tables are cached as
// BACKTEST_DATA_DIR/tables/<Y>.json with a fingerprint of the source rows they came from, and rebuilt when the history
// before that date has changed (the backfill adds older bars, a new ticker appears).

/** The build script's options (scripts/build-volatility-model-tables.ts). */
export const walkForwardMaxHorizon = 35;
export const walkForwardBucketCount = 500;
/** Raise when the cache format or the build rule changes, so old caches are rebuilt. */
const walkForwardCacheVersion = 1;

export interface WalkForwardSourceFingerprint {
  cacheVersion: number;
  cutoffIso: string;
  tickerCount: number;
  barCount: number;
  impliedVolatilityCount: number;
  earningsCount: number;
  firstBarDateIso: string | null;
  lastBarDateIso: string | null;
  etfSymbols: string[];
}

interface WalkForwardCacheFile {
  fingerprint: WalkForwardSourceFingerprint;
  buildSeconds: number;
  tables: VolatilityModelTables;
}

export interface ModelTablesForSession {
  /** The tables a session day is valued with. */
  tablesFor(dateIso: string): VolatilityModelTables;
  /** One line per year: built or cached, sample range, build time. */
  report: string[];
}

export function walkForwardCachePath(dataDirectory: string, year: number): string {
  return path.join(dataDirectory, "tables", `${year}.json`);
}

/** What the history before `cutoffIso` consists of: any change means the cached tables are stale. */
export async function loadWalkForwardSourceFingerprint(cutoffIso: string, connection: Knex = db): Promise<WalkForwardSourceFingerprint> {
  const [bars, earnings, etfRows] = await Promise.all([
    connection("daily_price_bars")
      .whereRaw("trading_date < ?::date", [cutoffIso])
      .whereNotNull("open_price")
      .whereNotNull("close_price")
      .first(connection.raw("count(*)::int as bar_count"), connection.raw("count(implied_volatility)::int as implied_volatility_count"), connection.raw("count(distinct ticker_id)::int as ticker_count"), connection.raw("min(trading_date)::text as first_bar"), connection.raw("max(trading_date)::text as last_bar")),
    connection("ticker_calendar_events").where({ event_type: "earnings" }).whereRaw("event_date < ?::date", [cutoffIso]).first(connection.raw("count(*)::int as earnings_count")),
    connection("tickers").where({ sector: "ETF" }).orderBy("symbol").select("symbol"),
  ]);
  return {
    cacheVersion: walkForwardCacheVersion,
    cutoffIso,
    tickerCount: Number(bars?.ticker_count ?? 0),
    barCount: Number(bars?.bar_count ?? 0),
    impliedVolatilityCount: Number(bars?.implied_volatility_count ?? 0),
    earningsCount: Number(earnings?.earnings_count ?? 0),
    firstBarDateIso: bars?.first_bar ?? null,
    lastBarDateIso: bars?.last_bar ?? null,
    etfSymbols: (etfRows as { symbol: string }[]).map((row) => row.symbol),
  };
}

/** Every ticker's history before `cutoffIso`, shaped as the build script shapes it (bars with an open and a close, all earnings dates before the cutoff). */
export async function loadTickerHistoriesBefore(cutoffIso: string, connection: Knex = db): Promise<TickerHistoryInput[]> {
  const [tickerRows, barRows, earningsRows] = await Promise.all([
    connection("tickers").select("id", "symbol", "sector") as Promise<{ id: string; symbol: string; sector: string | null }[]>,
    connection("daily_price_bars")
      .whereRaw("trading_date < ?::date", [cutoffIso])
      .select("ticker_id", connection.raw('trading_date::text as "tradingDate"'), "open_price", "high_price", "low_price", "close_price", "volume", "implied_volatility")
      .orderBy([{ column: "ticker_id" }, { column: "trading_date" }]) as Promise<{ ticker_id: string; tradingDate: string; open_price: string | null; high_price: string | null; low_price: string | null; close_price: string | null; volume: string | null; implied_volatility: string | null }[]>,
    connection("ticker_calendar_events").where({ event_type: "earnings" }).whereRaw("event_date < ?::date", [cutoffIso]).select("ticker_id", connection.raw('event_date::text as "eventDate"')) as Promise<{ ticker_id: string; eventDate: string }[]>,
  ]);
  const barsByTicker = new Map<string, TickerHistoryInput["bars"]>();
  for (const row of barRows) {
    if (row.open_price === null || row.close_price === null) continue;
    const bars = barsByTicker.get(row.ticker_id) ?? [];
    bars.push({ tradingDate: row.tradingDate, open: Number(row.open_price), high: Number(row.high_price), low: Number(row.low_price), close: Number(row.close_price), volume: Number(row.volume ?? 0), impliedVolatility: row.implied_volatility === null ? null : Number(row.implied_volatility) });
    barsByTicker.set(row.ticker_id, bars);
  }
  const earningsByTicker = new Map<string, string[]>();
  for (const row of earningsRows) earningsByTicker.set(row.ticker_id, [...(earningsByTicker.get(row.ticker_id) ?? []), row.eventDate]);
  return tickerRows
    .map((ticker) => ({ symbol: ticker.symbol, group: isEtfSector(ticker.sector) ? ("etf" as const) : ("stock" as const), bars: barsByTicker.get(ticker.id) ?? [], earningsDatesIso: earningsByTicker.get(ticker.id) ?? [] }))
    .filter((ticker) => ticker.bars.length > 22);
}

function fingerprintsMatch(a: WalkForwardSourceFingerprint, b: WalkForwardSourceFingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Builds (or reads from the cache) the tables for year `year`: history strictly before `${year}-01-01`. */
export async function walkForwardTablesForYear(dataDirectory: string, year: number, connection: Knex = db): Promise<{ tables: VolatilityModelTables; cached: boolean; buildSeconds: number }> {
  const cutoffIso = `${year}-01-01`;
  const cachePath = walkForwardCachePath(dataDirectory, year);
  const fingerprint = await loadWalkForwardSourceFingerprint(cutoffIso, connection);
  if (existsSync(cachePath)) {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as WalkForwardCacheFile;
    if (fingerprintsMatch(cache.fingerprint, fingerprint)) return { tables: cache.tables, cached: true, buildSeconds: cache.buildSeconds };
  }
  const startedAtMs = Date.now();
  const tickers = await loadTickerHistoriesBefore(cutoffIso, connection);
  let tables: VolatilityModelTables;
  try {
    tables = buildVolatilityModelTables(tickers, {
      maxHorizon: walkForwardMaxHorizon,
      bucketCount: walkForwardBucketCount,
      builtAtIso: new Date().toISOString(),
      source: `daily_price_bars before ${cutoffIso} of ${tickers.length} tickers (${tickers.map((ticker) => ticker.symbol).join(", ")})`,
    });
  } catch (error) {
    const groups = (["etf", "stock"] as const).map((group) => `${group === "etf" ? "ETFs" : "stocks"}: ${tickers.filter((ticker) => ticker.group === group).length} tickers`).join(", ");
    throw new Error(`The walk-forward model tables for ${year} cannot be built from the history before ${cutoffIso} (${groups}; ${fingerprint.barCount} bars from ${fingerprint.firstBarDateIso ?? "none"}): ${error instanceof Error ? error.message : String(error)}. Start the session in a later year or use the current tables.`);
  }
  const buildSeconds = (Date.now() - startedAtMs) / 1000;
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ fingerprint, buildSeconds, tables } satisfies WalkForwardCacheFile));
  return { tables, cached: false, buildSeconds };
}

/** The tables for every session day; walk-forward builds (or reads) one set per calendar year the days touch. */
export async function prepareModelTablesForSession(mode: BacktestTablesMode, sessionDatesIso: readonly string[], dataDirectory: string, onYearStarted: (year: number) => Promise<void> = async () => {}, connection: Knex = db): Promise<ModelTablesForSession> {
  if (mode === "current") {
    return { tablesFor: () => currentVolatilityModelTables, report: [`current tables (built ${currentVolatilityModelTables.builtAtIso}, sample ${currentVolatilityModelTables.sampleFromIso} → ${currentVolatilityModelTables.sampleToIso})`] };
  }
  const years = [...new Set(sessionDatesIso.map((dateIso) => Number(dateIso.slice(0, 4))))].sort((a, b) => a - b);
  const tablesByYear = new Map<number, VolatilityModelTables>();
  const report: string[] = [];
  for (const year of years) {
    await onYearStarted(year);
    const { tables, cached, buildSeconds } = await walkForwardTablesForYear(dataDirectory, year, connection);
    tablesByYear.set(year, tables);
    const calibrationPoints = tables.calibration.reduce((sum, row) => sum + row.points.length, 0);
    report.push(`${year}: ${cached ? "cached" : "built"} in ${buildSeconds.toFixed(1)} s, sample ${tables.sampleFromIso} → ${tables.sampleToIso}, ${calibrationPoints} calibration points`);
  }
  return {
    tablesFor: (dateIso) => {
      const tables = tablesByYear.get(Number(dateIso.slice(0, 4)));
      if (!tables) throw new Error(`No model tables prepared for ${dateIso}.`);
      return tables;
    },
    report,
  };
}
