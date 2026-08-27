import { EventName, OptionType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { getCachedContractDetails } from "./fetchNewTickerData.js";
import { lookupPricingSnapshot } from "./fetchTickerOverview.js";
import {
  checkStrikeExists,
  daysBetween,
  fetchQuotesForContracts,
  lookupOptionParams,
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
}

export interface AlertCandidate {
  expiry: string; // YYYY-MM-DD
  strike: number;
  right: "call" | "put";
  delta: number;
  premium: number;
  dte: number;
  annualizedYield: number;
  spotPrice: number;
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

  const { expirations, strikes } = await lookupOptionParams(ib, symbol, contractDetails.conId);
  return { conId: contractDetails.conId, spotPrice, expirations, strikes };
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
      const validated = await Promise.all(
        candidates.map(async (strike) => ({ strike, exists: await checkStrikeExists(ib, symbol, expiry, strike) })),
      );
      const validStrikes = validated.filter((v) => v.exists).map((v) => v.strike);
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
    const capitalAtRisk = strategyKey === "covered_call" ? spotPrice : quote.strike;
    const annualizedYield = (premium / capitalAtRisk) * (365 / dte);

    candidates.push({
      expiry: toIsoDate(quote.expiry),
      strike: quote.strike,
      right,
      delta: quote.delta,
      premium,
      dte,
      annualizedYield,
      spotPrice,
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

  const quotes = await quoteOptionChain(connection, symbol, expiryStrikes);
  return rankCandidates(quotes, right, strategyKey, settings, prep.spotPrice);
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

  const preps = (
    await Promise.all(
      Array.from(settingsByStrategy.entries()).map(async ([strategyKey, settings]) => {
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

  const quotes = await fetchQuotesForContracts(ib, symbol, contracts);
  for (const { strategyKey, settings, right } of preps) {
    results.set(strategyKey, rankCandidates(quotes, right, strategyKey, settings, spotPrice));
  }
  return results;
}
