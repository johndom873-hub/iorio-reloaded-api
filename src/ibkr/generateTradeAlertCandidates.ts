import { getBestKnownStockPrice } from "../lib/priceService.js";
import { OptionType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { computeProbabilityOfProfit } from "../lib/blackScholesPop.js";
import { computeIvMetrics, type IvMetrics } from "../lib/ivMetrics.js";
import { getRiskFreeRate } from "../lib/riskFreeRate.js";
import { fetchAvailableUncoveredShares, fetchOpenPositionStrategyKeys } from "../lib/positionQueries.js";
import {
  computeMovingAverages,
  computeSupportResistance,
  type MovingAverages,
  type SupportResistanceResult,
  type SupportResistanceZone,
} from "../lib/technicalIndicators.js";
import { fetchCalendarConflictContext, findCalendarConflict, type CalendarConflictContext } from "./calendarConflict.js";
import { getCachedContractDetails } from "./fetchNewTickerData.js";
import { lookupPricingSnapshot } from "./fetchTickerOverview.js";
import { getCachedChartBars } from "./priceBarCache.js";
import { hasPriceAndDelta, quoteContracts, type QuoteContractRequest } from "./quoteContracts.js";
import { peekPooledQuote } from "./marketDataPool.js";
import { nextReqIdFor } from "./sharedReadConnection.js";
import { db } from "../db/connection.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";
import {
  daysBetween,
  loadStoredOptionChain,
  parseExpiry,
  type ExpiryStrikes,
  type OptionQuote,
  type StoredOptionChain,
} from "./fetchOptionChain.js";

export type AlertStrategyKey = "covered_call" | "cash_secured_put";

export interface AlertStrategySettings {
  deltaTargetMin: number;
  deltaTargetMax: number;
  dteTargetMin: number;
  dteTargetMax: number;
  // covered_call only — governs delta selection instead of
  // deltaTargetMin/Max when the account already owns at least one
  // contract's worth (100 shares) of uncovered stock in the ticker being
  // scanned (see fetchAvailableUncoveredShares). Null for cash_secured_put,
  // which has no "existing position" concept, and unused by the roll scan
  // (generateRollCandidates.ts), which only ever replaces a leg on an
  // already-open position.
  deltaTargetMinExistingPosition: number | null;
  deltaTargetMaxExistingPosition: number | null;
}

// One options contract covers 100 shares — fewer uncovered shares than that
// can't back a real covered call, so it's treated as the generic/buy-write
// case. Approved by the user 2026-09-01.
const sharesPerContract = 100;

export interface AlertCandidate {
  expiry: string; // YYYY-MM-DD
  strike: number;
  right: "call" | "put";
  delta: number;
  premium: number;
  // Raw bid/ask behind `premium` (their midpoint) -- kept so a roll's net
  // credit can be checked against the real cost of crossing the spread
  // rather than just comparing two already-blended midpoints. Null when the
  // quote fell back to last price (see fetchOptionChain.ts). See
  // lib/rollEconomics.ts's halfSpread.
  bid: number | null;
  ask: number | null;
  dte: number;
  annualizedYield: number;
  spotPrice: number;
  // Black-Scholes N(d2)-based estimate, breakeven-adjusted -- see
  // blackScholesPop.ts's header for why, and its "pending validation" note.
  // Null when the underlying quote had no usable IV.
  probabilityOfProfit: number | null;
  // See lib/ivMetrics.ts — both null with too little IV history (e.g. a
  // newly-added ticker).
  ivRank: number | null;
  ivPercentile: number | null;
  // True when this ticker has never resolved to a TradingView symbol, so its
  // earnings/ex-dividend calendar couldn't be checked — the candidate was
  // NOT excluded on that basis (absence of data isn't evidence of absence of
  // an event), but the caller should say so rather than imply a clean check.
  calendarUnverified: boolean;
  // Support/resistance proximity context, informational only (Slice 2A,
  // approved 2026-09-01 — see PROGRESS.md and technicalIndicators.ts's
  // header) — describes the strike's location relative to a detected zone,
  // never reorders or excludes candidates. Null when no qualifying zone sits
  // within 1.0x ATR of the strike, or when support/resistance couldn't be
  // computed (e.g. too little hourly bar history).
  technicalNote: string | null;
  // (ask - bid) / premium * 100 -- how much of the quoted mid premium is
  // "spread risk" if the real fill lands away from the mid. Informational
  // only, same as technicalNote/ivRank -- never affects ranking. Null when
  // bid/ask aren't both available (see `bid`/`ask` above).
  bidAskSpreadPct: number | null;
  // Ticker-level daily-MA trend context (technicalIndicators.ts's
  // computeMovingAverages, same math already shown on Ticker Detail),
  // computed once per ticker scan rather than per candidate. Null when
  // there's under 99 days of daily bar history yet. Informational only,
  // approved 2026-09-05 -- see buildTrendLabel.
  trendLabel: "uptrend" | "downtrend" | "mixed" | null;
}

// 1.0x ATR trigger and quality>=40 gate, both approved 2026-09-01 after
// reviewing the academic evidence on support/resistance predictive power
// (Zapranis & Tsinaslanidis 2012, Osler 2000, arXiv:2101.07410) — see
// PROGRESS.md's Slice 2A discussion. Deliberately descriptive, not
// prescriptive: states touches/quality/distance as facts, never a
// buy/avoid recommendation, since the research supports the zones as real
// context but not as a standalone directional edge.
const technicalNoteAtrMultiple = 1.0;

// Covered calls care about the strike's distance from resistance (assignment
// risk if price breaks through); cash-secured puts care about distance from
// support (elevated breakout-through risk if the strike sits inside a weak
// support zone). Same zone-quality gate either side.
// Exported for a focused unit test (generateTradeAlertCandidates.test.ts) —
// decouples verifying this pure formatting/threshold logic from IBKR's live
// pricing pacing, which flakes independently of this code being correct.
export function buildTechnicalNote(strike: number, right: "call" | "put", supportResistance: SupportResistanceResult | null): string | null {
  if (!supportResistance) return null;
  const zone: SupportResistanceZone | null = right === "call" ? supportResistance.resistance : supportResistance.support;
  if (!zone || zone.qualityPct < 40) return null;

  const distance = Math.abs(strike - zone.price);
  if (distance > technicalNoteAtrMultiple * zone.atr) return null;

  const distancePct = (distance / zone.price) * 100;
  const label = right === "call" ? "resistance" : "support";
  const direction = strike >= zone.price ? "above" : "below";
  return `Strike is ${distancePct.toFixed(1)}% ${direction} a detected ${label} zone at $${zone.price.toFixed(2)} (${zone.touches} touches, ${zone.qualityPct.toFixed(1)}% quality).`;
}

// Uptrend/downtrend require spot and both MAs to agree on direction;
// anything else (a MA crossover, or price sitting between them) is "mixed"
// rather than forced into one bucket. Approved 2026-09-05 alongside
// bidAskSpreadPct -- both informational-only additions, no ranking change.
// Exported for a focused unit test, same reasoning as buildTechnicalNote.
export function buildTrendLabel(spotPrice: number, movingAverages: MovingAverages): "uptrend" | "downtrend" | "mixed" | null {
  if (movingAverages.ma25 === null || movingAverages.ma99 === null) return null;
  if (spotPrice > movingAverages.ma25 && movingAverages.ma25 > movingAverages.ma99) return "uptrend";
  if (spotPrice < movingAverages.ma25 && movingAverages.ma25 < movingAverages.ma99) return "downtrend";
  return "mixed";
}

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

// Bounded to keep IBKR call volume per ticker predictable — see the
// per-expiry mktdata-line-budget reasoning in fetchOptionChain.ts. Alerts
// only need a handful of ranked candidates, not exhaustive coverage.
const maxExpiriesToScan = 2;
// Percentage-of-spot band, not a fixed nearest-N count — delta 0.20-0.30
// (the default strategy_settings target) can live well beyond the nearest
// strikes for a higher-IV underlying. Verified empirically against NVDA
// (spot ~$219, 36 DTE): the 12 nearest strikes above spot only reached
// delta 0.37-0.52, all above target — delta 0.20-0.30 didn't show up until
// strikes 240-245, ~10-12% OTM. 40% comfortably covers that with margin.
// Capped at 50 raw candidates afterward as a safety valve against
// pathologically fine strike grids.
const otmBandFraction = 0.4;
const maxStrikeCandidatesPerExpiry = 50;
// One-shot-connection numbering only: on a shared connection every id comes
// from that connection's own counter (nextReqIdFor), or two concurrent
// callers collide ("Duplicate ticker id", found 2026-09-24 once the
// per-ticker refresh started borrowing the shared live connection).
const contractDetailsReqId = 1;
const pricingReqId = 2;
const hourlyBarsReqId = 3;
const dailyBarsReqId = 4;
// Hourly bars are keyed by bar-start time; a bar is still forming if it
// started within the last hour — mirrors streamTickerDetail.ts's identical
// check.
const oneHourInSeconds = 3600;

function pickExpiriesInWindow(expirations: string[], dteMin: number, dteMax: number): string[] {
  const today = new Date();
  return expirations
    .filter((expiry) => {
      const dte = daysBetween(today, parseExpiry(expiry));
      return dte >= dteMin && dte <= dteMax;
    })
    .sort()
    .slice(0, maxExpiriesToScan);
}

// Covered calls/CSPs are conventionally sold out-of-the-money — calls above
// spot, puts below — so candidates are picked one-sided and nearest-first,
// unlike fetchOptionChain.ts's near-the-money-both-sides selection for the
// Ticker Detail modal.
function pickCandidateStrikes(strikes: number[], spotPrice: number, right: "call" | "put"): number[] {
  const sorted = [...strikes].sort((a, b) => a - b);
  if (right === "call") {
    return sorted
      .filter((s) => s > spotPrice && s <= spotPrice * (1 + otmBandFraction))
      .slice(0, maxStrikeCandidatesPerExpiry);
  }
  return sorted
    .filter((s) => s < spotPrice && s >= spotPrice * (1 - otmBandFraction))
    .slice(-maxStrikeCandidatesPerExpiry)
    .reverse();
}

function toIsoDate(expiryYyyymmdd: string): string {
  return `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
}

interface TickerPrepData {
  conId: number | null;
  spotPrice: number | null;
  chain: StoredOptionChain;
}

const emptyChain: StoredOptionChain = { expirations: [], strikesByExpiry: new Map(), fetchedAt: null };

// contractDetails + pricing snapshot (IBKR) and the stored chain structure
// (DB, written by the nightly capture — never fetched here) for one ticker:
// the lookups that don't depend on which strategy is being scanned.
// Factored out so the batch scan (generateTradeAlertCandidatesForTicker) can
// fetch this once per ticker and reuse it across both strategies, instead of
// each strategy paying for it independently.
/**
 * The underlying's current price for a scan: the pool first (a screen already
 * streaming this stock costs nothing), else one pricing snapshot, then the
 * shared price hierarchy (priceService.ts) — a real last, else the stored
 * last known good; the previous close only as a last resort.
 */
export async function resolveScanSpotPrice(connection: IbkrConnection, symbol: string, reqId: number): Promise<number | null> {
  const pooled = peekPooledQuote({ key: symbol, legType: "stock", symbol })?.last ?? null;
  if (pooled !== null) return pooled;
  try {
    const pricing = await lookupPricingSnapshot(connection, symbol, reqId);
    return pricing.last ?? (await getBestKnownStockPrice(symbol)) ?? pricing.previousClose;
  } catch (error) {
    // A snapshot that times out (REALTIME outside market hours) must not sink
    // the whole scan/refresh: the stored last known good price still picks
    // the strikes correctly, and the option quotes decide the rest.
    console.warn(`${symbol}: pricing snapshot failed (${error instanceof Error ? error.message : error}) — using the last known price.`);
    return getBestKnownStockPrice(symbol);
  }
}

async function fetchTickerPrepData(connection: IbkrConnection, symbol: string, tickerId: string, knownSpotPrice?: number): Promise<TickerPrepData> {
  const contractDetailsPromise = getCachedContractDetails(connection, symbol, nextReqIdFor(connection.ib, () => contractDetailsReqId));
  const spotPricePromise = knownSpotPrice !== undefined ? Promise.resolve(knownSpotPrice) : resolveScanSpotPrice(connection, symbol, nextReqIdFor(connection.ib, () => pricingReqId));

  const [contractDetails, spotPrice] = await Promise.all([contractDetailsPromise, spotPricePromise]);
  if (!contractDetails.conId || !spotPrice) {
    return { conId: contractDetails.conId, spotPrice: null, chain: emptyChain };
  }

  const chain = await loadStoredOptionChain(tickerId);
  if (chain.strikesByExpiry.size === 0) console.warn(`${symbol}: option chain not prepared yet (no stored strike grids) — no candidates until the nightly capture or the Shortlist backfill stores it.`);
  return { conId: contractDetails.conId, spotPrice, chain };
}

// Best-effort, ticker-level (not per-strategy) — reuses the same "3M"/hourly
// cache Ticker Detail's chart already warms (priceBarCache.ts), so this is
// usually a cache hit rather than a fresh IBKR historical-data call. Failure
// (e.g. brand-new ticker with too little hourly history) degrades to no
// technicalNote on any candidate rather than failing the ticker scan, same
// fail-open treatment as calendarUnverified above.
async function fetchTickerSupportResistance(connection: IbkrConnection, symbol: string, spotPrice: number): Promise<SupportResistanceResult | null> {
  try {
    const hourlyBars = await getCachedChartBars(connection, symbol, "3M", nextReqIdFor(connection.ib, () => hourlyBarsReqId));
    if (hourlyBars.length === 0) return null;
    const lastBar = hourlyBars[hourlyBars.length - 1]!;
    const currentCandleIsOpen = Date.now() / 1000 - lastBar.time < oneHourInSeconds;
    return computeSupportResistance(hourlyBars, spotPrice, currentCandleIsOpen);
  } catch (error) {
    console.warn(`fetchTickerSupportResistance: failed for ${symbol} — ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

// Best-effort, ticker-level, same fail-open treatment as
// fetchTickerSupportResistance above -- reuses the same "1Y" daily-bar cache
// streamTickerDetail.ts's technicals panel already warms, so this is usually
// a cache hit. Failure or too little history (<99 days) degrades to no
// trendLabel on any candidate rather than failing the ticker scan.
async function fetchTickerTrendLabel(
  connection: IbkrConnection,
  symbol: string,
  spotPrice: number,
): Promise<"uptrend" | "downtrend" | "mixed" | null> {
  try {
    const dailyBars = await getCachedChartBars(connection, symbol, "1Y", nextReqIdFor(connection.ib, () => dailyBarsReqId));
    if (dailyBars.length === 0) return null;
    const closes = dailyBars.map((bar) => bar.close);
    return buildTrendLabel(spotPrice, computeMovingAverages(closes));
  } catch (error) {
    console.warn(`fetchTickerTrendLabel: failed for ${symbol} — ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

// (expiry, strike) pairs within a strategy's DTE window, one side only (calls
// above spot / puts below), picked from each expiry's stored real grid — so
// every pair exists, with no IBKR call.
function pickExpiryStrikesForStrategy(chain: StoredOptionChain, spotPrice: number, right: "call" | "put", dteMin: number, dteMax: number): ExpiryStrikes[] {
  return pickExpiriesInWindow(chain.expirations, dteMin, dteMax)
    .map((expiry) => ({ expiry, strikes: pickCandidateStrikes(chain.strikesByExpiry.get(expiry) ?? [], spotPrice, right) }))
    .filter((expiryStrikes) => expiryStrikes.strikes.length > 0);
}

/** `${expiryYyyymmdd}|${strike}|${C|P}` → the delta the 10:00 ET chain capture archived today. Empty when there is no capture for today. */
export type ArchivedDeltas = Map<string, number>;

export function archivedDeltaKey(expiryYyyymmdd: string, strike: number, right: "call" | "put"): string {
  return `${expiryYyyymmdd}|${strike}|${right === "call" ? "C" : "P"}`;
}

async function loadArchivedDeltasForToday(tickerId: string): Promise<ArchivedDeltas> {
  const rows: { expiry: string; strike: string; right: "C" | "P"; delta: string | null }[] = await db("option_quote_snapshots as q")
    .join("option_chain_snapshots as s", "s.id", "q.snapshot_id")
    .where({ "s.ticker_id": tickerId, "s.trading_date": easternDateIso(new Date()) })
    .whereIn("s.status", ["complete", "partial"])
    .whereNotNull("q.delta")
    .select(db.raw("to_char(q.expiry, 'YYYYMMDD') as expiry"), "q.strike", db.raw('q.option_right as "right"'), "q.delta");
  return new Map(rows.map((row) => [`${row.expiry}|${Number(row.strike)}|${row.right}`, Number(row.delta)]));
}

// How far outside the strategy's delta band an archived delta may sit and the
// strike still be quoted live — covers the intraday drift since 10:00 ET.
export const archivedDeltaMargin = 0.1;

/**
 * Trims the one-sided ±40% strike band to the strikes whose delta, as archived
 * by today's chain capture, can plausibly land in the strategy's target band
 * now (approved 2026-09-24). Only the delta band survives rankCandidates
 * anyway, so the far wings were pure line cost: ~200 contracts per ticker
 * quoted live to keep a dozen. A strike with no archived delta (not captured,
 * or captured without a model tick) is kept — absence is not evidence.
 * With no archive for today at all, the band is quoted in full as before.
 */
export function filterStrikesByArchivedDelta(expiryStrikes: ExpiryStrikes[], right: "call" | "put", settings: { deltaTargetMin: number; deltaTargetMax: number }, archived: ArchivedDeltas): ExpiryStrikes[] {
  if (archived.size === 0) return expiryStrikes;
  const lower = settings.deltaTargetMin - archivedDeltaMargin;
  const upper = settings.deltaTargetMax + archivedDeltaMargin;
  return expiryStrikes
    .map(({ expiry, strikes }) => ({
      expiry,
      strikes: strikes.filter((strike) => {
        const delta = archived.get(archivedDeltaKey(expiry, strike, right));
        if (delta === undefined) return true;
        const magnitude = Math.abs(delta);
        return magnitude >= lower && magnitude <= upper;
      }),
    }))
    .filter(({ strikes }) => strikes.length > 0);
}

function toQuoteRequests(expiryStrikes: ExpiryStrikes[], right: "call" | "put"): QuoteContractRequest[] {
  const optionType = right === "call" ? OptionType.Call : OptionType.Put;
  return expiryStrikes.flatMap(({ expiry, strikes }) => strikes.map((strike) => ({ expiry, strike, right: optionType })));
}

function rankCandidates(
  quotes: OptionQuote[],
  right: "call" | "put",
  strategyKey: AlertStrategyKey,
  settings: AlertStrategySettings,
  spotPrice: number,
  calendarContext: CalendarConflictContext,
  ivMetrics: IvMetrics,
  supportResistance: SupportResistanceResult | null,
  trendLabel: "uptrend" | "downtrend" | "mixed" | null,
  riskFreeRate: number | null,
): AlertCandidate[] {
  const optionType = right === "call" ? OptionType.Call : OptionType.Put;
  const today = new Date();

  const candidates: AlertCandidate[] = [];
  for (const quote of quotes) {
    if (quote.right !== optionType || quote.delta === null) continue;
    const deltaMagnitude = Math.abs(quote.delta);
    if (deltaMagnitude < settings.deltaTargetMin || deltaMagnitude > settings.deltaTargetMax) continue;

    const premium = quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : quote.last;
    if (premium === null || premium <= 0) continue;

    const dte = daysBetween(today, parseExpiry(quote.expiry));
    if (dte <= 0) continue;
    const expiryIso = toIsoDate(quote.expiry);
    if (findCalendarConflict(calendarContext, strategyKey, expiryIso)) continue;
    const capitalAtRisk = strategyKey === "covered_call" ? spotPrice : quote.strike;
    const annualizedYield = (premium / capitalAtRisk) * (365 / dte);
    const bidAskSpreadPct = quote.bid !== null && quote.ask !== null ? ((quote.ask - quote.bid) / premium) * 100 : null;
    const probabilityOfProfit =
      quote.impliedVolatility !== null
        ? computeProbabilityOfProfit({
            spotPrice,
            strike: quote.strike,
            premium,
            impliedVolatility: quote.impliedVolatility,
            daysToExpiry: dte,
            right,
            riskFreeRate,
          })
        : null;

    candidates.push({
      expiry: expiryIso,
      strike: quote.strike,
      right,
      delta: quote.delta,
      premium,
      bid: quote.bid,
      ask: quote.ask,
      dte,
      annualizedYield,
      spotPrice,
      probabilityOfProfit,
      ivRank: ivMetrics.ivRank,
      ivPercentile: ivMetrics.ivPercentile,
      calendarUnverified: !calendarContext.resolved,
      technicalNote: buildTechnicalNote(quote.strike, right, supportResistance),
      bidAskSpreadPct,
      trendLabel,
    });
  }

  return candidates.sort((a, b) => b.annualizedYield - a.annualizedYield);
}

/**
 * Scans one ticker's option chain for candidate strikes matching a
 * strategy's delta/DTE window (from strategy_settings), ranked by
 * annualized premium yield. Ranking formula approved 2026-08-20:
 *   annualizedYield = (premium / capitalAtRisk) * (365 / dte)
 * capitalAtRisk = spot price for a covered call (the stock you'd hold),
 * strike price for a cash-secured put (the cash you'd reserve). Returns
 * candidates sorted descending by yield — caller decides how many to keep.
 * Also silently drops any candidate whose expiry would leave it open across
 * a known earnings date (either strategy) or ex-dividend date (covered calls
 * only) — see calendarConflict.ts. A ticker with no calendar data at all
 * isn't excluded on that basis (see AlertCandidate.calendarUnverified).
 *
 * Single-strategy, single-ticker: used by the roll scan (generateRollCandidates.ts),
 * which only ever needs one strategy's replacement for one leg at a time. The
 * batch trade-alert scan uses generateTradeAlertCandidatesForTicker instead,
 * which shares this function's prep/rank building blocks across both
 * strategies for the same ticker.
 */
export async function generateTradeAlertCandidates(
  connection: IbkrConnection,
  symbol: string,
  tickerId: string,
  strategyKey: AlertStrategyKey,
  settings: AlertStrategySettings,
  options: GenerateTradeAlertCandidatesOptions = {},
): Promise<AlertCandidate[]> {
  const right: "call" | "put" = strategyKey === "covered_call" ? "call" : "put";

  const prep = await fetchTickerPrepData(connection, symbol, tickerId, options.spotPrice);
  if (!prep.conId || !prep.spotPrice) {
    console.warn(`Skipping ${symbol} (${strategyKey}) — missing conId or spot price.`);
    return [];
  }

  const archivedDeltas = await loadArchivedDeltasForToday(tickerId);
  const expiryStrikes = filterStrikesByArchivedDelta(pickExpiryStrikesForStrategy(prep.chain, prep.spotPrice, right, settings.dteTargetMin, settings.dteTargetMax), right, settings, archivedDeltas);
  if (expiryStrikes.length === 0) return [];

  // One right only (a covered call never ranks puts) — half the lines of the old call+put chain quote.
  const [quotes, calendarContext, ivMetrics, supportResistance, trendLabel, riskFreeRate] = await Promise.all([
    quoteContracts(connection.ib, symbol, toQuoteRequests(expiryStrikes, right), { priorityLines: options.priorityLines }),
    fetchCalendarConflictContext(tickerId),
    computeIvMetrics(tickerId),
    fetchTickerSupportResistance(connection, symbol, prep.spotPrice),
    fetchTickerTrendLabel(connection, symbol, prep.spotPrice),
    getRiskFreeRate().catch(() => null),
  ]);
  return rankCandidates(quotes, right, strategyKey, settings, prep.spotPrice, calendarContext, ivMetrics, supportResistance, trendLabel, riskFreeRate);
}

/**
 * Batch variant of generateTradeAlertCandidates for the daily trade-alert
 * scan (runTradeAlertGeneration.ts), which needs both covered_call and
 * cash_secured_put candidates for the same ticker. Fetches contractDetails,
 * pricing, and secDefOptParams once instead of once per strategy, and quotes
 * both strategies' strikes through one batched fetch (fetchQuotesInBatches)
 * instead of two separate quoteOptionChain calls.
 */
export interface GenerateTradeAlertCandidatesOptions {
  /** Scheduled scan only — see QuoteContractsOptions.priorityLines. */
  priorityLines?: boolean;
  /** The underlying's price when the caller already has it (the recovery path's own snapshot); omitted → resolveScanSpotPrice. */
  spotPrice?: number;
  /** Reports how many contracts were quoted and how many came back usable — so a caller can tell "no candidates" from "no quotes". */
  onQuoteStats?: (stats: QuoteStats) => void;
}

export interface QuoteStats {
  requested: number;
  withPriceAndDelta: number;
  /** True when the ticker could not even be prepared (no contract id, no spot price, no stored strike grid) — nothing was quoted, so "no candidates" is not a finding. */
  prepFailed: boolean;
}

export async function generateTradeAlertCandidatesForTicker(
  connection: IbkrConnection,
  symbol: string,
  tickerId: string,
  settingsByStrategy: Map<AlertStrategyKey, AlertStrategySettings>,
  options: GenerateTradeAlertCandidatesOptions = {},
): Promise<Map<AlertStrategyKey, AlertCandidate[]>> {
  const { ib } = connection;
  const results = new Map<AlertStrategyKey, AlertCandidate[]>();

  const prep = await fetchTickerPrepData(connection, symbol, tickerId);
  if (!prep.conId || !prep.spotPrice) {
    console.warn(`Skipping ${symbol} — missing conId or spot price.`);
    options.onQuoteStats?.({ requested: 0, withPriceAndDelta: 0, prepFailed: true });
    return results;
  }
  if (prep.chain.strikesByExpiry.size === 0) {
    options.onQuoteStats?.({ requested: 0, withPriceAndDelta: 0, prepFailed: true });
    return results;
  }
  const spotPrice = prep.spotPrice;

  // A ticker that already has an open position for a strategy shouldn't also
  // get new-trade alerts for that same strategy — once there's exposure, the
  // roll scan (runTradeAlertGeneration.ts's separate per-leg pass) is what's
  // supposed to surface actionable suggestions for it, not another "open a
  // new position" candidate. Approved 2026-09-15.
  const coveredCallSettings = settingsByStrategy.get("covered_call");
  const [uncoveredShares, openPositionStrategies] = await Promise.all([
    fetchAvailableUncoveredShares(tickerId),
    fetchOpenPositionStrategyKeys(tickerId),
  ]);

  let effectiveSettingsByStrategy = settingsByStrategy;

  // covered_call is the one strategy where "already has a position" doesn't
  // by itself mean "no room" — shares beyond what's already covered
  // (uncoveredShares) can still back a fresh contract. Only suppress when an
  // open covered_call position exists AND there's no uncovered capacity left;
  // otherwise keep today's behavior of using the existing-position delta
  // range once there's ≥1 contract's worth of uncovered shares to write
  // against.
  if (coveredCallSettings) {
    if (openPositionStrategies.has("covered_call") && uncoveredShares < sharesPerContract) {
      effectiveSettingsByStrategy = new Map(settingsByStrategy);
      effectiveSettingsByStrategy.delete("covered_call");
    } else if (
      uncoveredShares >= sharesPerContract &&
      coveredCallSettings.deltaTargetMinExistingPosition !== null &&
      coveredCallSettings.deltaTargetMaxExistingPosition !== null
    ) {
      effectiveSettingsByStrategy = new Map(settingsByStrategy);
      effectiveSettingsByStrategy.set("covered_call", {
        ...coveredCallSettings,
        deltaTargetMin: coveredCallSettings.deltaTargetMinExistingPosition,
        deltaTargetMax: coveredCallSettings.deltaTargetMaxExistingPosition,
      });
    }
  }

  // cash_secured_put has no partial-coverage concept — any open CSP position
  // on this ticker means "already have exposure," full stop.
  if (openPositionStrategies.has("cash_secured_put") && effectiveSettingsByStrategy.has("cash_secured_put")) {
    if (effectiveSettingsByStrategy === settingsByStrategy) effectiveSettingsByStrategy = new Map(settingsByStrategy);
    effectiveSettingsByStrategy.delete("cash_secured_put");
  }

  const preps = Array.from(effectiveSettingsByStrategy.entries())
    .map(([strategyKey, settings]) => {
      const right: "call" | "put" = strategyKey === "covered_call" ? "call" : "put";
      const expiryStrikes = pickExpiryStrikesForStrategy(prep.chain, spotPrice, right, settings.dteTargetMin, settings.dteTargetMax);
      return { strategyKey, settings, right, expiryStrikes };
    })
    .filter((p) => p.expiryStrikes.length > 0);

  const archivedDeltas = await loadArchivedDeltasForToday(tickerId);
  const contracts: QuoteContractRequest[] = preps.flatMap((prep) => toQuoteRequests(filterStrikesByArchivedDelta(prep.expiryStrikes, prep.right, prep.settings, archivedDeltas), prep.right));
  if (contracts.length === 0) {
    options.onQuoteStats?.({ requested: 0, withPriceAndDelta: 0, prepFailed: false });
    return results;
  }

  const [quotes, calendarContext, ivMetrics, supportResistance, trendLabel, riskFreeRate] = await Promise.all([
    quoteContracts(ib, symbol, contracts, { priorityLines: options.priorityLines }),
    fetchCalendarConflictContext(tickerId),
    computeIvMetrics(tickerId),
    fetchTickerSupportResistance(connection, symbol, spotPrice),
    fetchTickerTrendLabel(connection, symbol, spotPrice),
    getRiskFreeRate().catch(() => null),
  ]);
  options.onQuoteStats?.({ requested: contracts.length, withPriceAndDelta: quotes.filter(hasPriceAndDelta).length, prepFailed: false });
  for (const { strategyKey, settings, right } of preps) {
    results.set(strategyKey, rankCandidates(quotes, right, strategyKey, settings, spotPrice, calendarContext, ivMetrics, supportResistance, trendLabel, riskFreeRate));
  }
  return results;
}
