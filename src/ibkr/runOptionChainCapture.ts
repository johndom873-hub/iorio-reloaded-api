import { EventName } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { refreshStoredOptionChain, loadStoredOptionChain, type OptionChainRefreshTimings, type StoredOptionChainRefresh } from "./fetchOptionChain.js";
import { fetchLivePrices } from "./fetchLivePrices.js";
import { openCaptureQuoteWindow, type CaptureQuoteWindow, type CaptureSettleStats, type CapturedOptionQuote, type OptionContractRequest } from "./captureOptionQuoteBatch.js";
import { getRiskFreeRateForJob } from "../lib/riskFreeRate.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "../lib/realizedVolatility.js";
import {
  calendarDaysUntilExpiry,
  captureBothSidesWithinFractionOfSpot,
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
  describeSnapshotQualityProblems,
  isTickerStarved,
  optionChainCaptureBatchSize,
  recapturePassMaximumDurationMs,
  shouldRecaptureStarvedTicker,
  type OptionChainMarketDataType,
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
const captureProgressLogIntervalMs = 10_000;

/**
 * One line of empirical line usage: how many lines were subscribed (now, and the lowest/highest during
 * the period), the time-weighted average in use, and how long each released contract held its line.
 */
export function describeCaptureLineUsage(heading: string, inFlight: number | null, stats: CaptureSettleStats): string {
  const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const fields = (counts: CaptureSettleStats["lastField"]) => `price ${counts.price}, delta ${counts.delta}, OI ${counts.openInterest}`;
  const averageInUse = stats.intervalMs > 0 ? (stats.lineBusyMs / stats.intervalMs).toFixed(1) : "—";
  const released = stats.settled + stats.timedOut + stats.errored;
  return (
    `${heading}: lines ${inFlight === null ? "" : `${inFlight}/${optionChainCaptureBatchSize} now, `}min ${stats.minInFlight ?? "—"} max ${stats.maxInFlight ?? "—"}, ` +
    `avg in use ${averageInUse} over ${seconds(stats.intervalMs)}; ${released} released, held p50 ${seconds(stats.holdMsP50)} p90 ${seconds(stats.holdMsP90)} max ${seconds(stats.holdMsMax)}; ` +
    `${stats.settled} full data (waited last on ${fields(stats.lastField)}), ` +
    `${stats.timedOut} timed out holding ${seconds(stats.timedOutLineMs)} of line time (missing ${fields(stats.missingOnTimeout)}), ${stats.errored} errored.`
  );
}
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
  failedSymbols: string[];
  recapturedSymbols: string[];
  /** True when no risk-free rate was available, so every snapshot was saved without one and no surface can be fitted from them. */
  riskFreeRateUnavailable: boolean;
  /** Tickers whose spot came from a stored price, not a live one: the strike window and the stored underlying price are stale. */
  fallbackSpotSymbols: string[];
  /** One entry per captured snapshot that is weak (partial, thin quotes or IV, not real-time), e.g. "AAA: two-sided quotes 60% (min 75%)". */
  qualityProblems: string[];
}

/** One line for the job alert when the capture ran but part of its work is unusable, or undefined when it is clean. */
export function buildCaptureFailureMessage(result: OptionChainCaptureResult): string | undefined {
  const problems: string[] = [];
  if (result.tickersAttempted === 0) problems.push("no tickers to capture (shortlist and open positions are both empty)");
  if (result.tickersFailed > 0) problems.push(`${result.tickersFailed} of ${result.tickersAttempted} tickers not captured: ${result.failedSymbols.join(", ")}`);
  if (result.riskFreeRateUnavailable) problems.push("risk-free rate unavailable (FRED fetch failed and none is stored), so the snapshots were saved without it and no surface can be fitted");
  if (result.fallbackSpotSymbols.length > 0) problems.push(`spot price came from a stored fallback, not live: ${result.fallbackSpotSymbols.join(", ")}`);
  if (result.qualityProblems.length > 0) problems.push(`weak snapshots: ${result.qualityProblems.join(", ")}`);
  return problems.length > 0 ? problems.join("; ") : undefined;
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
  /** Open short option legs' exact contracts (Roll Signals): always captured, whatever side or strike window they sit in. */
  loadOpenShortLegContracts: (tickerId: string) => Promise<OptionContractRequest[]>;
}

/** The contracts of every open short option leg on this ticker, in the capture's YYYYMMDD expiry form. */
export async function loadOpenShortLegContracts(tickerId: string): Promise<OptionContractRequest[]> {
  const rows: { expiry: string; strike: string; optionType: "call" | "put" }[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.ticker_id": tickerId, "p.status": "open", "pl.leg_type": "option", "pl.side": "short" })
    .whereNull("pl.exit_at")
    .select(db.raw("to_char(pl.expiry_date, 'YYYYMMDD') as expiry"), "pl.strike_price as strike", "pl.option_type as optionType");
  return rows.map((row) => ({ expiry: row.expiry, strike: Number(row.strike), right: row.optionType === "call" ? "C" : "P" }));
}

const defaultPrepareDependencies: PrepareTickerDependencies = {
  fetchSpotPrice: async (symbol) => (await fetchLivePrices([{ key: symbol, legType: "stock", symbol }]))[symbol],
  loadReferenceVolatility,
  refreshStoredOptionChain,
  loadOpenShortLegContracts,
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
    for (const contract of selectContractsToCapture(chain.strikesByExpiry.get(expiry) ?? [], spotPrice, window, { bothSidesWithinFractionOfSpot: captureBothSidesWithinFractionOfSpot })) contracts.push({ expiry, ...contract });
  }
  // Roll Signals (2026-09-24): an open short leg is scored as a contract to keep, so its exact
  // contract is always captured -- the window above is OTM-side only, which is precisely the
  // side an ITM leg (the defensive-roll case) is not on. A past expiry is left out.
  const captured = new Set(contracts.map((contract) => `${contract.expiry}|${contract.strike}|${contract.right}`));
  for (const heldContract of await dependencies.loadOpenShortLegContracts(ticker.tickerId)) {
    const key = `${heldContract.expiry}|${heldContract.strike}|${heldContract.right}`;
    if (captured.has(key) || calendarDaysUntilExpiry(todayIso, heldContract.expiry) < 0) continue;
    captured.add(key);
    contracts.push(heldContract);
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
  fetchSpotPrices: (symbols: string[], onFallbackPriceUsed?: (symbols: string[]) => void) => Promise<Record<string, number | null>>;
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
  getRiskFreeRate: getRiskFreeRateForJob,
  connect: connectToIbkrGateway,
  fetchSpotPrices: async (symbols, onFallbackPriceUsed) => fetchLivePrices(symbols.map((symbol) => ({ key: symbol, legType: "stock", symbol })), { priorityLines: true, onFallbackPriceUsed }),
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

export interface OptionChainCaptureOptions {
  /** Capture only these tickers (the retry rounds); default is the whole universe. */
  symbols?: string[];
  /** The caller already holds the priority line reservation (and let the pool shed), so this run neither reserves nor releases it. */
  linesAlreadyHeld?: boolean;
}

/**
 * Reserves the capture's priority lines and keeps the reservation alive until the returned function
 * releases it. Throws when the lines are not available. The retry rounds hold ONE reservation across rounds.
 */
export async function holdCaptureLineReservation(lineReservation: OptionChainCaptureDependencies["lineReservation"] = defaultCaptureDependencies.lineReservation): Promise<() => Promise<void>> {
  const reservation = await lineReservation.reserve(captureLineReservationHolder, optionChainCaptureBatchSize, captureLineReservationTtlSeconds);
  if (!reservation.ok) throw new Error(describeMarketDataLineShortage(reservation, "the chain capture", optionChainCaptureBatchSize));
  const renewTimer = setInterval(() => {
    lineReservation.renew(captureLineReservationHolder, captureLineReservationTtlSeconds).catch((error) => console.warn(`could not renew the capture's line reservation: ${error instanceof Error ? error.message : error}`));
  }, captureLineReservationRenewIntervalMs);
  renewTimer.unref?.();
  return async () => {
    clearInterval(renewTimer);
    await lineReservation.release(captureLineReservationHolder).catch((error) => console.warn(`could not release the capture's line reservation: ${error instanceof Error ? error.message : error}`));
  };
}

export async function runOptionChainCapture(
  onEvent: (event: OptionChainCaptureEvent) => void = () => {},
  dependencies: OptionChainCaptureDependencies = defaultCaptureDependencies,
  options: OptionChainCaptureOptions = {},
): Promise<OptionChainCaptureResult> {
  const jobStartedAt = dependencies.now().getTime();
  const todayIso = easternDateIso(dependencies.now());
  const fullUniverse = await dependencies.loadUniverse();
  const universe = options.symbols === undefined ? fullUniverse : fullUniverse.filter((ticker) => options.symbols!.includes(ticker.symbol));
  const riskFreeRate = await dependencies.getRiskFreeRate();
  const riskFreeRatePercent = riskFreeRate === null ? null : riskFreeRate * 100;
  const result: OptionChainCaptureResult = { tickersAttempted: universe.length, tickersComplete: 0, tickersPartial: 0, tickersFailed: 0, failedSymbols: [], recapturedSymbols: [], riskFreeRateUnavailable: riskFreeRate === null, fallbackSpotSymbols: [], qualityProblems: [] };
  const starved: { prepared: PreparedTicker; coverage: SnapshotCoverage }[] = [];
  const finalStatusBySymbol = new Map<string, string>();
  // Latest saved coverage and data type per ticker (a re-capture overwrites the first pass).
  const snapshotQualityBySymbol = new Map<string, { coverage: SnapshotCoverage; marketDataType: OptionChainMarketDataType }>();

  const releaseLines = options.linesAlreadyHeld ? async () => {} : await holdCaptureLineReservation(dependencies.lineReservation);

  let connection: { ib: IbkrApi; disconnect: () => void } | null = null;
  let window: CaptureQuoteWindow | null = null;
  // A dropped connection (e.g. a Gateway restart) closes the window and stops the run: carrying on
  // would subscribe every remaining ticker on the dead socket for 0 ticks while holding the lines.
  let connectionLost = false;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  const onDisconnected = () => {
    connectionLost = true;
    window?.close();
  };
  try {
    if (!options.linesAlreadyHeld) await dependencies.waitForPoolShedding();
    connection = await dependencies.connect();
    const { ib } = connection;
    ib.once(EventName.disconnected, onDisconnected);
    window = dependencies.openQuoteWindow(ib);
    const quoteWindow = window;
    // How many of the reserved lines are really subscribed (Pulse counts the whole reservation as in use).
    progressTimer = setInterval(() => console.log(describeCaptureLineUsage("Capture window", quoteWindow.inFlightCount(), quoteWindow.drainSettleStats())), captureProgressLogIntervalMs);
    progressTimer.unref?.();
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
      const coverage = await dependencies.saveSnapshot(prepared, quotes, todayIso, riskFreeRatePercent, dependencies.now().getTime() - startedAt);
      snapshotQualityBySymbol.set(prepared.ticker.symbol, { coverage, marketDataType: deriveMarketDataType(quotes) });
      return coverage;
    };

    // Preparation runs ahead: each ticker's contracts are queued on the shared
    // window as soon as they are known, and its snapshot is saved (in the
    // background) once its last contract settles. Failures stay per ticker.
    const spotBySymbol = universe.length > 0 ? await dependencies.fetchSpotPrices(universe.map((ticker) => ticker.symbol), (symbols) => result.fallbackSpotSymbols.push(...symbols)) : {};
    const captures: Promise<void>[] = [];
    for (const ticker of universe) {
      if (connectionLost) break;
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
    if (connectionLost) {
      const notCaptured = universe.filter((ticker) => finalStatusBySymbol.get(ticker.symbol) !== "complete" && finalStatusBySymbol.get(ticker.symbol) !== "partial").map((ticker) => ticker.symbol);
      throw new Error(`IBKR connection lost mid-run; not captured: ${notCaptured.join(", ")}`);
    }

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
    if (progressTimer) clearInterval(progressTimer);
    if (window) console.log(describeCaptureLineUsage("Capture run total", null, window.wholeRunSettleStats()));
    connection?.ib.removeListener(EventName.disconnected, onDisconnected);
    window?.close();
    connection?.disconnect();
    await releaseLines();
  }
  for (const [symbol, status] of finalStatusBySymbol) {
    if (status === "complete") result.tickersComplete++;
    else if (status === "partial") result.tickersPartial++;
    else {
      result.tickersFailed++;
      result.failedSymbols.push(symbol);
    }
  }
  for (const [symbol, quality] of snapshotQualityBySymbol) {
    if (finalStatusBySymbol.get(symbol) === "failed") continue;
    const problems = describeSnapshotQualityProblems(quality.coverage, quality.marketDataType);
    if (problems.length > 0) result.qualityProblems.push(`${symbol}: ${problems.join(", ")}`);
  }
  return result;
}
