import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { refreshStoredOptionChain, type OptionChainRefreshTimings, type StoredOptionChainRefresh } from "./fetchOptionChain.js";
import { fetchLivePrices } from "./fetchLivePrices.js";
import { captureOptionQuoteBatch, type CapturedOptionQuote, type OptionContractRequest } from "./captureOptionQuoteBatch.js";
import { getRiskFreeRate } from "../lib/riskFreeRate.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "../lib/realizedVolatility.js";
import {
  calendarDaysUntilExpiry,
  captureMaximumDaysToExpiry,
  captureMinimumDaysToExpiry,
  computeStrikeWindow,
  selectContractsToCapture,
  type StrikeWindow,
} from "../lib/optionChainCaptureWindow.js";
import { chooseReferenceVolatility, type ReferenceVolatilitySource } from "../lib/optionChainCaptureReferenceVolatility.js";
import {
  computeSnapshotCoverage,
  deriveMarketDataType,
  deriveSnapshotStatus,
  isTickerStarved,
  optionChainCaptureBatchSize,
  recapturePassMaximumDurationMs,
  shouldRecaptureStarvedTicker,
  splitIntoBatches,
  type SnapshotCoverage,
} from "../lib/optionChainCaptureCoverage.js";
import { saveOptionChainSnapshot } from "../lib/optionChainSnapshotStore.js";
import { excludeTickersBeingPrepared } from "../lib/tickersBeingPrepared.js";

// Nightly option-chain archive (IORIO Signal Engine, Phase 0). One ticker at a
// time, batches of 60 contracts one after another (approved 2026-09-21: keeps
// one batch inside IBKR's 100 market-data-line cap and clear of the live app).
// Chain structure (expiries + each expiry's real strike grid) is fetched and
// stored here, one wildcard lookup at a time (Marcelo, 2026-09-23) — see
// refreshStoredOptionChain; every other reader takes it from the DB.

const widestWindowHalfWidth = 0.5;
const referenceVolatilityBarCount = 40;

export type OptionChainCaptureEvent =
  | { type: "tickerStart"; symbol: string; contractCount: number; referenceVolatilitySource: ReferenceVolatilitySource; chainRefresh: OptionChainRefreshTimings }
  | { type: "tickerDone"; symbol: string; status: string; coverage: SnapshotCoverage }
  | { type: "tickerError"; symbol: string; message: string }
  | { type: "recaptureStart"; symbols: string[] };

export interface OptionChainCaptureResult {
  tickersAttempted: number;
  tickersComplete: number;
  tickersPartial: number;
  tickersFailed: number;
  recapturedSymbols: string[];
}

export interface UniverseTicker {
  tickerId: string;
  symbol: string;
  contractId: number | null;
}

export interface PreparedTicker {
  ticker: UniverseTicker;
  spotPrice: number;
  referenceVolatility: number | null;
  referenceVolatilitySource: ReferenceVolatilitySource;
  contracts: OptionContractRequest[];
  /** How long IBKR took for the expiries list and each expiry's strike grid — logged by the job and kept in job_runs.details. */
  chainRefresh: OptionChainRefreshTimings;
}

/** Shortlist (not removed) + tickers with an open position, de-duplicated. No hardcoded symbols (approved 2026-09-21). Tickers still being prepared by the new-ticker backfill are skipped (approved 2026-09-21). */
export async function loadCaptureUniverse(): Promise<UniverseTicker[]> {
  const rows: { tickerId: string; symbol: string; contractId: number | null }[] = await excludeTickersBeingPrepared(
    db("tickers as t").where((builder) =>
      builder
        .whereIn("t.id", db("shortlist_entries").whereNull("removed_at").select("ticker_id"))
        .orWhereIn("t.id", db("positions").where({ status: "open" }).select("ticker_id")),
    ),
    "t.id",
  )
    .select("t.id as tickerId", "t.symbol", "t.ibkr_contract_id as contractId")
    .orderBy("t.symbol");
  return rows;
}

async function loadReferenceVolatility(tickerId: string, todayIso: string) {
  const bars: { tradingDate: string; open: string | null; high: string | null; low: string | null; close: string | null; volume: string | null; impliedVolatility: string | null }[] = await db("daily_price_bars")
    .where({ ticker_id: tickerId })
    .orderBy("trading_date", "desc")
    .limit(referenceVolatilityBarCount)
    .select(
      db.raw("trading_date::text as \"tradingDate\""),
      db.raw("open_price as open"),
      db.raw("high_price as high"),
      db.raw("low_price as low"),
      db.raw("close_price as close"),
      "volume",
      db.raw("implied_volatility as \"impliedVolatility\""),
    );
  const latestWithIv = bars.find((bar) => bar.impliedVolatility !== null);
  const usableBars: DailyOhlcvBar[] = bars
    .filter((bar) => bar.open !== null && bar.high !== null && bar.low !== null && bar.close !== null)
    .reverse()
    .map((bar) => ({ tradingDate: bar.tradingDate, open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volume ?? 0) }));
  const yangZhang = computeYangZhangVolatility(usableBars, 21);
  return chooseReferenceVolatility({
    todayIso,
    latestImpliedVolatility: latestWithIv ? Number(latestWithIv.impliedVolatility) : null,
    latestImpliedVolatilityDateIso: latestWithIv?.tradingDate ?? null,
    yangZhang21DayVolatility: yangZhang.available ? yangZhang.annualizedVolatility : null,
  });
}

function windowFor(spotPrice: number, referenceVolatility: number | null, daysToExpiry: number): StrikeWindow | null {
  if (referenceVolatility !== null) return computeStrikeWindow({ spotPrice, atmImpliedVolatility: referenceVolatility, daysToExpiry });
  return {
    halfWidth: widestWindowHalfWidth,
    lowerBound: spotPrice * Math.exp(-widestWindowHalfWidth),
    upperBound: spotPrice * Math.exp(widestWindowHalfWidth),
  };
}

type IbkrApi = Parameters<typeof refreshStoredOptionChain>[0];

/** The IBKR/DB lookups prepareTicker needs; injectable so the contract-selection logic is testable offline. */
export interface PrepareTickerDependencies {
  fetchSpotPrice: (symbol: string) => Promise<number | null | undefined>;
  loadReferenceVolatility: (tickerId: string, todayIso: string) => Promise<{ volatility: number | null; source: ReferenceVolatilitySource }>;
  refreshStoredOptionChain: (ib: IbkrApi, ticker: { tickerId: string; symbol: string; contractId: number }, todayIso: string) => Promise<StoredOptionChainRefresh>;
}

const defaultPrepareDependencies: PrepareTickerDependencies = {
  fetchSpotPrice: async (symbol) => (await fetchLivePrices([{ key: symbol, legType: "stock", symbol }]))[symbol],
  loadReferenceVolatility,
  refreshStoredOptionChain,
};

export async function prepareTicker(ib: IbkrApi, ticker: UniverseTicker, todayIso: string, dependencies: PrepareTickerDependencies = defaultPrepareDependencies): Promise<PreparedTicker> {
  if (ticker.contractId === null) throw new Error("no ibkr_contract_id stored for this ticker");
  const spotPrice = await dependencies.fetchSpotPrice(ticker.symbol);
  if (spotPrice === null || spotPrice === undefined || !(spotPrice > 0)) throw new Error("no usable spot price");

  const reference = await dependencies.loadReferenceVolatility(ticker.tickerId, todayIso);
  const chain = await dependencies.refreshStoredOptionChain(ib, { tickerId: ticker.tickerId, symbol: ticker.symbol, contractId: ticker.contractId }, todayIso);
  const contracts: OptionContractRequest[] = [];
  for (const expiry of [...chain.expirations].sort()) {
    const daysToExpiry = calendarDaysUntilExpiry(todayIso, expiry);
    if (daysToExpiry < captureMinimumDaysToExpiry || daysToExpiry > captureMaximumDaysToExpiry) continue;
    const window = windowFor(spotPrice, reference.volatility, daysToExpiry);
    if (!window) continue;
    // Selected from the expiry's real grid, so every contract here exists.
    for (const contract of selectContractsToCapture(chain.strikesByExpiry.get(expiry) ?? [], spotPrice, window)) contracts.push({ expiry, ...contract });
  }
  return { ticker, spotPrice, referenceVolatility: reference.volatility, referenceVolatilitySource: reference.source, contracts, chainRefresh: chain.timings };
}

async function captureAllBatches(ib: IbkrApi, prepared: PreparedTicker): Promise<CapturedOptionQuote[]> {
  const captured: CapturedOptionQuote[] = [];
  for (const batch of splitIntoBatches(prepared.contracts, optionChainCaptureBatchSize)) {
    captured.push(...(await captureOptionQuoteBatch(ib, prepared.ticker.symbol, batch)));
  }
  return captured;
}

async function loadNextExDividend(tickerId: string, todayIso: string): Promise<{ date: string | null; amount: number | null }> {
  const row = await db("ticker_calendar_events")
    .where({ ticker_id: tickerId, event_type: "ex_dividend" })
    .where("event_date", ">=", todayIso)
    .orderBy("event_date")
    .select(db.raw("event_date::text as \"eventDate\""), "amount")
    .first();
  return { date: row?.eventDate ?? null, amount: row?.amount === null || row?.amount === undefined ? null : Number(row.amount) };
}

export async function captureAndSave(ib: IbkrApi, prepared: PreparedTicker, todayIso: string, riskFreeRatePercent: number | null): Promise<SnapshotCoverage> {
  const startedAt = Date.now();
  const quotes = await captureAllBatches(ib, prepared);
  const coverage = computeSnapshotCoverage(quotes);
  const exDividend = await loadNextExDividend(prepared.ticker.tickerId, todayIso);
  await saveOptionChainSnapshot(
    {
      tickerId: prepared.ticker.tickerId,
      tradingDate: todayIso,
      capturedAt: new Date(),
      underlyingPrice: prepared.spotPrice,
      riskFreeRatePercent,
      nextExDividendDate: exDividend.date,
      nextExDividendAmount: exDividend.amount,
      referenceImpliedVolatility: prepared.referenceVolatilitySource === "implied_volatility" ? prepared.referenceVolatility : null,
      marketDataType: deriveMarketDataType(quotes),
      coverage,
      captureDurationMs: Date.now() - startedAt,
      status: deriveSnapshotStatus(coverage),
      errorMessage: prepared.referenceVolatilitySource === "implied_volatility" ? null : `strike window sized from ${prepared.referenceVolatilitySource}`,
    },
    quotes,
  );
  return coverage;
}

/** Records a failed header so a ticker that could not be captured is visible, not silently absent. */
export async function saveFailedSnapshot(ticker: UniverseTicker, todayIso: string, message: string): Promise<void> {
  const emptyCoverage: SnapshotCoverage = { contractsRequested: 0, contractsWithAnyTick: 0, contractsWithTwoSidedQuote: 0, contractsWithImpliedVolatility: 0 };
  await saveOptionChainSnapshot(
    {
      tickerId: ticker.tickerId,
      tradingDate: todayIso,
      capturedAt: new Date(),
      underlyingPrice: null,
      riskFreeRatePercent: null,
      nextExDividendDate: null,
      nextExDividendAmount: null,
      referenceImpliedVolatility: null,
      marketDataType: "unknown",
      coverage: emptyCoverage,
      captureDurationMs: null,
      status: "failed",
      errorMessage: message,
    },
    [],
  );
}

/** Everything runOptionChainCapture touches outside itself; injectable so the run logic is testable offline. */
export interface OptionChainCaptureDependencies {
  now: () => Date;
  loadUniverse: () => Promise<UniverseTicker[]>;
  getRiskFreeRate: () => Promise<number | null>;
  connect: () => Promise<{ ib: IbkrApi; disconnect: () => void }>;
  prepareTicker: (ib: IbkrApi, ticker: UniverseTicker, todayIso: string) => Promise<PreparedTicker>;
  captureAndSave: (ib: IbkrApi, prepared: PreparedTicker, todayIso: string, riskFreeRatePercent: number | null) => Promise<SnapshotCoverage>;
  saveFailedSnapshot: (ticker: UniverseTicker, todayIso: string, message: string) => Promise<void>;
}

const defaultCaptureDependencies: OptionChainCaptureDependencies = {
  now: () => new Date(),
  loadUniverse: loadCaptureUniverse,
  getRiskFreeRate,
  connect: connectToIbkrGateway,
  prepareTicker: (ib, ticker, todayIso) => prepareTicker(ib, ticker, todayIso),
  captureAndSave,
  saveFailedSnapshot,
};

export async function runOptionChainCapture(
  onEvent: (event: OptionChainCaptureEvent) => void = () => {},
  dependencies: OptionChainCaptureDependencies = defaultCaptureDependencies,
): Promise<OptionChainCaptureResult> {
  const jobStartedAt = dependencies.now().getTime();
  const todayIso = easternDateIso(dependencies.now());
  const universe = await dependencies.loadUniverse();
  const riskFreeRate = await dependencies.getRiskFreeRate();
  const riskFreeRatePercent = riskFreeRate === null ? null : riskFreeRate * 100;
  const result: OptionChainCaptureResult = { tickersAttempted: universe.length, tickersComplete: 0, tickersPartial: 0, tickersFailed: 0, recapturedSymbols: [] };
  const starved: { prepared: PreparedTicker; coverage: SnapshotCoverage }[] = [];
  const finalStatusBySymbol = new Map<string, string>();

  const { ib, disconnect } = await dependencies.connect();
  try {
    const record = (symbol: string, coverage: SnapshotCoverage) => {
      const status = deriveSnapshotStatus(coverage);
      finalStatusBySymbol.set(symbol, status);
      onEvent({ type: "tickerDone", symbol, status, coverage });
    };
    for (const ticker of universe) {
      try {
        const prepared = await dependencies.prepareTicker(ib, ticker, todayIso);
        onEvent({ type: "tickerStart", symbol: ticker.symbol, contractCount: prepared.contracts.length, referenceVolatilitySource: prepared.referenceVolatilitySource, chainRefresh: prepared.chainRefresh });
        const coverage = await dependencies.captureAndSave(ib, prepared, todayIso, riskFreeRatePercent);
        record(ticker.symbol, coverage);
        if (isTickerStarved(coverage)) starved.push({ prepared, coverage });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onEvent({ type: "tickerError", symbol: ticker.symbol, message });
        finalStatusBySymbol.set(ticker.symbol, "failed");
        await dependencies.saveFailedSnapshot(ticker, todayIso, message).catch((saveError: unknown) => console.warn(`could not record failed snapshot for ${ticker.symbol}: ${saveError}`));
      }
    }

    // One re-capture pass for starved tickers (too few contracts got any tick), time-boxed.
    const recaptureCandidates = starved.filter(({ coverage }) => shouldRecaptureStarvedTicker(coverage, dependencies.now().getTime() - jobStartedAt)).map(({ prepared }) => prepared);
    if (recaptureCandidates.length > 0) {
      onEvent({ type: "recaptureStart", symbols: recaptureCandidates.map((prepared) => prepared.ticker.symbol) });
      const passStartedAt = dependencies.now().getTime();
      for (const prepared of recaptureCandidates) {
        if (dependencies.now().getTime() - passStartedAt > recapturePassMaximumDurationMs) break;
        try {
          const coverage = await dependencies.captureAndSave(ib, prepared, todayIso, riskFreeRatePercent);
          record(prepared.ticker.symbol, coverage);
          result.recapturedSymbols.push(prepared.ticker.symbol);
        } catch (error) {
          onEvent({ type: "tickerError", symbol: prepared.ticker.symbol, message: `re-capture failed: ${error instanceof Error ? error.message : error}` });
        }
      }
    }
  } finally {
    disconnect();
  }
  for (const status of finalStatusBySymbol.values()) {
    if (status === "complete") result.tickersComplete++;
    else if (status === "partial") result.tickersPartial++;
    else result.tickersFailed++;
  }
  return result;
}
