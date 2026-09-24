import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { refreshStoredOptionChain, loadStoredOptionChain, type OptionChainRefreshTimings, type StoredOptionChainRefresh } from "./fetchOptionChain.js";
import { fetchLivePrices } from "./fetchLivePrices.js";
import { openCaptureQuoteWindow, type CaptureQuoteWindow, type CapturedOptionQuote, type OptionContractRequest } from "./captureOptionQuoteBatch.js";
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
  type SnapshotCoverage,
} from "../lib/optionChainCaptureCoverage.js";
import { saveOptionChainSnapshot } from "../lib/optionChainSnapshotStore.js";
import { excludeTickersBeingPrepared } from "../lib/tickersBeingPrepared.js";
import { describeMarketDataLineShortage, releaseMarketDataLines, renewMarketDataLineReservation, reserveMarketDataLines, type LineReservationResult } from "./marketDataLineBudget.js";

// The job holds ONE priority reservation for its whole run (approved
// 2026-09-24): live screens see the budget minus these lines and the live
// pool sheds to fit, so the capture can never be starved. Batches then run
// under this reservation instead of reserving individually.
export const captureLineReservationHolder = "optionChainCapture";
const captureLineReservationTtlSeconds = 180;
const captureLineReservationRenewIntervalMs = 60_000;
// The live pool re-checks the budget every 15 s (marketDataPool.ts) and
// pauses subscriptions to make room; the first batch waits this long after
// the reservation so it never competes with lines that are still being shed.
const poolSheddingGraceMs = 20_000;

// Nightly option-chain archive (IORIO Signal Engine, Phase 0). One rolling
// window of optionChainCaptureBatchSize lines across every ticker's contracts
// (approved 2026-09-24, replacing fixed per-ticker batches that waited on
// their slowest contract — see openCaptureQuoteWindow): tickers are prepared
// one after another and their contracts queued as soon as each is ready, so
// the next ticker's contracts take lines the moment the previous ticker's
// settle. A ticker's snapshot is saved when its last contract settles.
// Ticks only — chain STRUCTURE (expiries + each expiry's real strike grid) is
// refreshed earlier, pre-market, by runOptionChainStructureRefresh.ts (split
// off 2026-09-23 since structure has no market-open dependency, unlike
// ticks). This job's default dependencies (ticksOnlyPrepareDependencies,
// below) read that structure from the DB instead of refreshing it — see
// fetchOptionChain.ts's refreshStoredOptionChain (live fetch, still used
// directly by both that job and tickerBackfillPipeline.ts for onboarding a
// brand-new ticker) and loadStoredOptionChain (DB read).

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

// Used by the nightly ticks job's defaultCaptureDependencies below only —
// tickerBackfillPipeline.ts (onboarding a brand-new ticker, which has no
// stored-today structure yet) keeps using prepareTicker's own live-refresh
// default above. Wraps the existing loadStoredOptionChain (a DB read, no
// IBKR call — also used by Ticker Detail/position quotes/the alert scan) in
// StoredOptionChainRefresh's shape so prepareTicker's contract-selection
// logic is unchanged; timings are zeroed since no IBKR round trip happened
// here. Requires fetchedAt to be today: loadStoredOptionChain itself has no
// freshness opinion (a stale-but-present chain is fine for those other
// readers), but capturing ticks against yesterday's expiries — possibly
// already expired or rolled — would be silently wrong, so this fails the
// ticker clearly instead when the pre-market structure job
// (run-option-chain-structure-job.ts) hasn't run yet today.
export const ticksOnlyPrepareDependencies: PrepareTickerDependencies = {
  ...defaultPrepareDependencies,
  refreshStoredOptionChain: async (_ib, ticker, todayIso) => {
    const stored = await loadStoredOptionChain(ticker.tickerId);
    if (!stored.fetchedAt || easternDateIso(stored.fetchedAt) !== todayIso) {
      throw new Error("no chain structure captured for today yet — the pre-market structure job may not have run");
    }
    return { expirations: stored.expirations, strikesByExpiry: stored.strikesByExpiry, timings: { optionParamsMs: 0, expiries: [], totalMs: 0 } };
  },
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


async function loadNextExDividend(tickerId: string, todayIso: string): Promise<{ date: string | null; amount: number | null }> {
  const row = await db("ticker_calendar_events")
    .where({ ticker_id: tickerId, event_type: "ex_dividend" })
    .where("event_date", ">=", todayIso)
    .orderBy("event_date")
    .select(db.raw("event_date::text as \"eventDate\""), "amount")
    .first();
  return { date: row?.eventDate ?? null, amount: row?.amount === null || row?.amount === undefined ? null : Number(row.amount) };
}

export async function saveCapturedSnapshot(prepared: PreparedTicker, quotes: CapturedOptionQuote[], todayIso: string, riskFreeRatePercent: number | null, captureDurationMs: number): Promise<SnapshotCoverage> {
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
      captureDurationMs,
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
  /** Every ticker's spot in ONE priority snapshot before the window starts, instead of one unbudgeted snapshot per ticker in the loop. */
  fetchSpotPrices: (symbols: string[]) => Promise<Record<string, number | null>>;
  prepareTicker: (ib: IbkrApi, ticker: UniverseTicker, todayIso: string, spotPrice: number | null) => Promise<PreparedTicker>;
  /** The rolling quote window shared by every ticker of the run — see openCaptureQuoteWindow. */
  openQuoteWindow: (ib: IbkrApi) => CaptureQuoteWindow;
  saveSnapshot: (prepared: PreparedTicker, quotes: CapturedOptionQuote[], todayIso: string, riskFreeRatePercent: number | null, captureDurationMs: number) => Promise<SnapshotCoverage>;
  saveFailedSnapshot: (ticker: UniverseTicker, todayIso: string, message: string) => Promise<void>;
  lineReservation: {
    reserve: (holder: string, lines: number, ttlSeconds: number) => Promise<LineReservationResult>;
    renew: (holder: string, ttlSeconds: number) => Promise<void>;
    release: (holder: string) => Promise<void>;
  };
  /** Pause after the priority reservation so the live pool can shed to fit before the first batch subscribes. */
  waitForPoolShedding: () => Promise<void>;
}

const defaultCaptureDependencies: OptionChainCaptureDependencies = {
  now: () => new Date(),
  loadUniverse: loadCaptureUniverse,
  getRiskFreeRate,
  connect: connectToIbkrGateway,
  fetchSpotPrices: async (symbols) => fetchLivePrices(symbols.map((symbol) => ({ key: symbol, legType: "stock", symbol })), { priorityLines: true }),
  prepareTicker: (ib, ticker, todayIso, spotPrice) => prepareTicker(ib, ticker, todayIso, { ...ticksOnlyPrepareDependencies, fetchSpotPrice: async () => spotPrice }),
  openQuoteWindow: (ib) => openCaptureQuoteWindow(ib, { concurrency: optionChainCaptureBatchSize }),
  saveSnapshot: saveCapturedSnapshot,
  saveFailedSnapshot,
  lineReservation: {
    reserve: (holder, lines, ttlSeconds) => reserveMarketDataLines(holder, lines, ttlSeconds, { priority: true }),
    renew: renewMarketDataLineReservation,
    release: releaseMarketDataLines,
  },
  waitForPoolShedding: () => new Promise((resolve) => setTimeout(resolve, poolSheddingGraceMs)),
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

  const reservation = await dependencies.lineReservation.reserve(captureLineReservationHolder, optionChainCaptureBatchSize, captureLineReservationTtlSeconds);
  if (!reservation.ok) throw new Error(describeMarketDataLineShortage(reservation, "the chain capture", optionChainCaptureBatchSize));
  const renewTimer = setInterval(() => {
    dependencies.lineReservation.renew(captureLineReservationHolder, captureLineReservationTtlSeconds).catch((error) => console.warn(`could not renew the capture's line reservation: ${error instanceof Error ? error.message : error}`));
  }, captureLineReservationRenewIntervalMs);
  renewTimer.unref?.();

  let connection: { ib: IbkrApi; disconnect: () => void } | null = null;
  let window: CaptureQuoteWindow | null = null;
  try {
    await dependencies.waitForPoolShedding();
    connection = await dependencies.connect();
    const { ib } = connection;
    window = dependencies.openQuoteWindow(ib);
    const quoteWindow = window;
    const record = (symbol: string, coverage: SnapshotCoverage) => {
      const status = deriveSnapshotStatus(coverage);
      finalStatusBySymbol.set(symbol, status);
      onEvent({ type: "tickerDone", symbol, status, coverage });
    };
    const recordFailure = async (ticker: UniverseTicker, message: string) => {
      onEvent({ type: "tickerError", symbol: ticker.symbol, message });
      finalStatusBySymbol.set(ticker.symbol, "failed");
      await dependencies.saveFailedSnapshot(ticker, todayIso, message).catch((saveError: unknown) => console.warn(`could not record failed snapshot for ${ticker.symbol}: ${saveError}`));
    };
    const captureAndSave = async (prepared: PreparedTicker): Promise<SnapshotCoverage> => {
      const startedAt = dependencies.now().getTime();
      const quotes = await quoteWindow.capture(prepared.ticker.symbol, prepared.contracts);
      return dependencies.saveSnapshot(prepared, quotes, todayIso, riskFreeRatePercent, dependencies.now().getTime() - startedAt);
    };

    // Preparation runs ahead: each ticker's contracts are queued on the shared
    // window as soon as they are known, and its snapshot is saved (in the
    // background) once its last contract settles. Failures stay per ticker.
    const spotBySymbol = universe.length > 0 ? await dependencies.fetchSpotPrices(universe.map((ticker) => ticker.symbol)) : {};
    const captures: Promise<void>[] = [];
    for (const ticker of universe) {
      let prepared: PreparedTicker;
      try {
        prepared = await dependencies.prepareTicker(ib, ticker, todayIso, spotBySymbol[ticker.symbol] ?? null);
      } catch (error) {
        await recordFailure(ticker, error instanceof Error ? error.message : String(error));
        continue;
      }
      onEvent({ type: "tickerStart", symbol: ticker.symbol, contractCount: prepared.contracts.length, referenceVolatilitySource: prepared.referenceVolatilitySource, chainRefresh: prepared.chainRefresh });
      captures.push(
        captureAndSave(prepared)
          .then((coverage) => {
            record(ticker.symbol, coverage);
            if (isTickerStarved(coverage)) starved.push({ prepared, coverage });
          })
          .catch((error: unknown) => recordFailure(ticker, error instanceof Error ? error.message : String(error))),
      );
    }
    await Promise.all(captures);

    // One re-capture pass for starved tickers (too few contracts got any tick):
    // every candidate is queued on the window at once so the lines stay busy,
    // and the pass budget is a deadline — when it expires the window is closed
    // and each still-open re-capture is saved with whatever it has.
    starved.sort((a, b) => universe.findIndex((ticker) => ticker.symbol === a.prepared.ticker.symbol) - universe.findIndex((ticker) => ticker.symbol === b.prepared.ticker.symbol));
    const recaptureCandidates = starved.filter(({ coverage }) => shouldRecaptureStarvedTicker(coverage, dependencies.now().getTime() - jobStartedAt)).map(({ prepared }) => prepared);
    if (recaptureCandidates.length > 0) {
      onEvent({ type: "recaptureStart", symbols: recaptureCandidates.map((prepared) => prepared.ticker.symbol) });
      const deadline = setTimeout(() => quoteWindow.close(), recapturePassMaximumDurationMs);
      try {
        await Promise.all(
          recaptureCandidates.map((prepared) =>
            captureAndSave(prepared)
              .then((coverage) => {
                record(prepared.ticker.symbol, coverage);
                result.recapturedSymbols.push(prepared.ticker.symbol);
              })
              .catch((error: unknown) => onEvent({ type: "tickerError", symbol: prepared.ticker.symbol, message: `re-capture failed: ${error instanceof Error ? error.message : error}` })),
          ),
        );
      } finally {
        clearTimeout(deadline);
      }
    }
  } finally {
    window?.close();
    connection?.disconnect();
    clearInterval(renewTimer);
    await dependencies.lineReservation.release(captureLineReservationHolder).catch((error) => console.warn(`could not release the capture's line reservation: ${error instanceof Error ? error.message : error}`));
  }
  for (const status of finalStatusBySymbol.values()) {
    if (status === "complete") result.tickersComplete++;
    else if (status === "partial") result.tickersPartial++;
    else result.tickersFailed++;
  }
  return result;
}
