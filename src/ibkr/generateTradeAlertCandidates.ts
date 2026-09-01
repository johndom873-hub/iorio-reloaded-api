import { EventName, OptionType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { computeProbabilityOfProfit } from "../lib/blackScholesPop.js";
import { computeIvMetrics, type IvMetrics } from "../lib/ivMetrics.js";
import { fetchAvailableUncoveredShares } from "../lib/positionQueries.js";
import { computeSupportResistance, type SupportResistanceResult, type SupportResistanceZone } from "../lib/technicalIndicators.js";
import { fetchCalendarConflictContext, findCalendarConflict, type CalendarConflictContext } from "./calendarConflict.js";
import { getCachedContractDetails } from "./fetchNewTickerData.js";
import { lookupPricingSnapshot } from "./fetchTickerOverview.js";
import { getCachedChartBars } from "./priceBarCache.js";
import {
  daysBetween,
  fetchQuotesForContracts,
  getCachedOptionParams,
  getCachedValidStrikes,
  parseExpiry,
  quoteOptionChain,
  type ExpiryStrikes,
  type OptionQuote,
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
const contractDetailsReqId = 1;
const pricingReqId = 2;
const hourlyBarsReqId = 3;
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
  expirations: string[];
  strikes: number[];
}

// contractDetails + pricing snapshot + secDefOptParams for one ticker — the
// three lookups that don't depend on which strategy is being scanned.
// Factored out so the batch scan (generateTradeAlertCandidatesForTicker) can
// fetch this once per ticker and reuse it across both strategies, instead of
// each strategy paying for it independently.
async function fetchTickerPrepData(connection: IbkrConnection, symbol: string): Promise<TickerPrepData> {
  const { ib } = connection;

  const contractDetailsPromise = getCachedContractDetails(connection, symbol, contractDetailsReqId);
  const pricingPromise = lookupPricingSnapshot(connection, symbol, pricingReqId);

  const [contractDetails, pricing] = await Promise.all([contractDetailsPromise, pricingPromise]);
  const spotPrice = pricing.last ?? pricing.previousClose;
  if (!contractDetails.conId || !spotPrice) {
    return { conId: contractDetails.conId, spotPrice: null, expirations: [], strikes: [] };
  }

  const { expirations, strikes } = await getCachedOptionParams(ib, symbol, contractDetails.conId);
  return { conId: contractDetails.conId, spotPrice, expirations, strikes };
}

// Best-effort, ticker-level (not per-strategy) — reuses the same "3M"/hourly
// cache Ticker Detail's chart already warms (priceBarCache.ts), so this is
// usually a cache hit rather than a fresh IBKR historical-data call. Failure
// (e.g. brand-new ticker with too little hourly history) degrades to no
// technicalNote on any candidate rather than failing the ticker scan, same
// fail-open treatment as calendarUnverified above.
async function fetchTickerSupportResistance(connection: IbkrConnection, symbol: string, spotPrice: number): Promise<SupportResistanceResult | null> {
  try {
    const hourlyBars = await getCachedChartBars(connection, symbol, "3M", hourlyBarsReqId);
    if (hourlyBars.length === 0) return null;
    const lastBar = hourlyBars[hourlyBars.length - 1]!;
    const currentCandleIsOpen = Date.now() / 1000 - lastBar.time < oneHourInSeconds;
    return computeSupportResistance(hourlyBars, spotPrice, currentCandleIsOpen);
  } catch (error) {
    console.warn(`fetchTickerSupportResistance: failed for ${symbol} — ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

// Validated (expiry, strike) pairs within a strategy's DTE window, one side
// only (calls above spot / puts below) — the per-expiry checkStrikeExists
// scans run in parallel across expiries, not sequentially, matching the
// pattern already used by prepareOptionChainStrikes in fetchOptionChain.ts
// (see that file's note on why sequential expiry lookups are ~4-5x slower).
async function buildValidatedExpiryStrikes(
  ib: IbkrConnection["ib"],
  symbol: string,
  expirations: string[],
  rawStrikes: number[],
  spotPrice: number,
  right: "call" | "put",
  dteMin: number,
  dteMax: number,
): Promise<ExpiryStrikes[]> {
  const qualifyingExpiries = pickExpiriesInWindow(expirations, dteMin, dteMax);
  const results = await Promise.all(
    qualifyingExpiries.map(async (expiry): Promise<ExpiryStrikes | null> => {
      const candidates = pickCandidateStrikes(rawStrikes, spotPrice, right);
      const validStrikes = await getCachedValidStrikes(ib, symbol, expiry, candidates);
      return validStrikes.length > 0 ? { expiry, strikes: validStrikes } : null;
    }),
  );
  return results.filter((r): r is ExpiryStrikes => r !== null);
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
    const probabilityOfProfit =
      quote.impliedVolatility !== null
        ? computeProbabilityOfProfit({
            spotPrice,
            strike: quote.strike,
            premium,
            impliedVolatility: quote.impliedVolatility,
            daysToExpiry: dte,
            right,
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
): Promise<AlertCandidate[]> {
  const { ib } = connection;
  const right: "call" | "put" = strategyKey === "covered_call" ? "call" : "put";

  const prep = await fetchTickerPrepData(connection, symbol);
  if (!prep.conId || !prep.spotPrice) {
    console.warn(`Skipping ${symbol} (${strategyKey}) — missing conId or spot price.`);
    return [];
  }

  const expiryStrikes = await buildValidatedExpiryStrikes(
    ib,
    symbol,
    prep.expirations,
    prep.strikes,
    prep.spotPrice,
    right,
    settings.dteTargetMin,
    settings.dteTargetMax,
  );
  if (expiryStrikes.length === 0) return [];

  const [quotes, calendarContext, ivMetrics, supportResistance] = await Promise.all([
    quoteOptionChain(connection, symbol, expiryStrikes),
    fetchCalendarConflictContext(tickerId),
    computeIvMetrics(tickerId),
    fetchTickerSupportResistance(connection, symbol, prep.spotPrice),
  ]);
  return rankCandidates(quotes, right, strategyKey, settings, prep.spotPrice, calendarContext, ivMetrics, supportResistance);
}

/**
 * Batch variant of generateTradeAlertCandidates for the daily trade-alert
 * scan (runTradeAlertGeneration.ts), which needs both covered_call and
 * cash_secured_put candidates for the same ticker. Fetches contractDetails,
 * pricing, and secDefOptParams once instead of once per strategy, and issues
 * a single fetchQuotesForContracts call covering both strategies' strikes
 * instead of two separate quoteOptionChain calls — each of those calls waits
 * a fixed 8s for IBKR to stream ticks back (see quoteTimeoutMs in
 * fetchOptionChain.ts), so this halves that fixed cost per ticker as well as
 * the duplicated setup lookups.
 */
export async function generateTradeAlertCandidatesForTicker(
  connection: IbkrConnection,
  symbol: string,
  tickerId: string,
  settingsByStrategy: Map<AlertStrategyKey, AlertStrategySettings>,
): Promise<Map<AlertStrategyKey, AlertCandidate[]>> {
  const { ib } = connection;
  const results = new Map<AlertStrategyKey, AlertCandidate[]>();

  const prep = await fetchTickerPrepData(connection, symbol);
  if (!prep.conId || !prep.spotPrice) {
    console.warn(`Skipping ${symbol} — missing conId or spot price.`);
    return results;
  }
  const spotPrice = prep.spotPrice;

  // covered_call new-trade candidates use the existing-position delta range
  // instead of the generic one when the account already owns enough
  // uncovered shares of this ticker to write a real covered call against —
  // otherwise this is a buy-write/hypothetical scan and the generic range
  // still applies.
  const coveredCallSettings = settingsByStrategy.get("covered_call");
  let effectiveSettingsByStrategy = settingsByStrategy;
  if (
    coveredCallSettings &&
    coveredCallSettings.deltaTargetMinExistingPosition !== null &&
    coveredCallSettings.deltaTargetMaxExistingPosition !== null
  ) {
    const uncoveredShares = await fetchAvailableUncoveredShares(tickerId);
    if (uncoveredShares >= sharesPerContract) {
      effectiveSettingsByStrategy = new Map(settingsByStrategy);
      effectiveSettingsByStrategy.set("covered_call", {
        ...coveredCallSettings,
        deltaTargetMin: coveredCallSettings.deltaTargetMinExistingPosition,
        deltaTargetMax: coveredCallSettings.deltaTargetMaxExistingPosition,
      });
    }
  }

  const preps = (
    await Promise.all(
      Array.from(effectiveSettingsByStrategy.entries()).map(async ([strategyKey, settings]) => {
        const right: "call" | "put" = strategyKey === "covered_call" ? "call" : "put";
        const expiryStrikes = await buildValidatedExpiryStrikes(
          ib,
          symbol,
          prep.expirations,
          prep.strikes,
          spotPrice,
          right,
          settings.dteTargetMin,
          settings.dteTargetMax,
        );
        return { strategyKey, settings, right, expiryStrikes };
      }),
    )
  ).filter((p) => p.expiryStrikes.length > 0);

  const contracts: { expiry: string; strike: number; right: OptionType }[] = [];
  for (const prep of preps) {
    const optionType = prep.right === "call" ? OptionType.Call : OptionType.Put;
    for (const { expiry, strikes } of prep.expiryStrikes) {
      for (const strike of strikes) {
        contracts.push({ expiry, strike, right: optionType });
      }
    }
  }
  if (contracts.length === 0) return results;

  const [quotes, calendarContext, ivMetrics, supportResistance] = await Promise.all([
    fetchQuotesForContracts(ib, symbol, contracts),
    fetchCalendarConflictContext(tickerId),
    computeIvMetrics(tickerId),
    fetchTickerSupportResistance(connection, symbol, spotPrice),
  ]);
  for (const { strategyKey, settings, right } of preps) {
    results.set(strategyKey, rankCandidates(quotes, right, strategyKey, settings, spotPrice, calendarContext, ivMetrics, supportResistance));
  }
  return results;
}
