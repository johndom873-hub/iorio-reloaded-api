import { EventName, OptionType, Stock } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { lookupContractDetails } from "./fetchNewTickerData.js";
import { lookupPricingSnapshot } from "./fetchTickerOverview.js";
import {
  checkStrikeExists,
  daysBetween,
  lookupOptionParams,
  parseExpiry,
  quoteOptionChain,
  type ExpiryStrikes,
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

/**
 * Scans one ticker's option chain for candidate strikes matching a
 * strategy's delta/DTE window (from strategy_settings), ranked by
 * annualized premium yield. Ranking formula approved 2026-08-20:
 *   annualizedYield = (premium / capitalAtRisk) * (365 / dte)
 * capitalAtRisk = spot price for a covered call (the stock you'd hold),
 * strike price for a cash-secured put (the cash you'd reserve). Returns
 * candidates sorted descending by yield — caller decides how many to keep.
 */
export async function generateTradeAlertCandidates(
  connection: IbkrConnection,
  symbol: string,
  strategyKey: AlertStrategyKey,
  settings: AlertStrategySettings,
): Promise<AlertCandidate[]> {
  const { ib } = connection;
  const right: "call" | "put" = strategyKey === "covered_call" ? "call" : "put";

  const contractDetailsPromise = lookupContractDetails(connection, contractDetailsReqId);
  ib.reqContractDetails(contractDetailsReqId, new Stock(symbol, "SMART", "USD"));
  const pricingPromise = lookupPricingSnapshot(connection, symbol, pricingReqId);

  const [contractDetails, pricing] = await Promise.all([contractDetailsPromise, pricingPromise]);
  const spotPrice = pricing.last ?? pricing.previousClose;
  if (!contractDetails.conId || !spotPrice) {
    console.warn(`Skipping ${symbol} (${strategyKey}) — missing conId or spot price.`);
    return [];
  }

  const { expirations, strikes } = await lookupOptionParams(ib, symbol, contractDetails.conId);
  const qualifyingExpiries = pickExpiriesInWindow(expirations, settings.dteTargetMin, settings.dteTargetMax);
  if (qualifyingExpiries.length === 0) return [];

  const expiryStrikes: ExpiryStrikes[] = [];
  for (const expiry of qualifyingExpiries) {
    const candidates = pickCandidateStrikes(strikes, spotPrice, right);
    const validated = await Promise.all(
      candidates.map(async (strike) => ({ strike, exists: await checkStrikeExists(ib, symbol, expiry, strike) })),
    );
    const validStrikes = validated.filter((v) => v.exists).map((v) => v.strike);
    if (validStrikes.length > 0) expiryStrikes.push({ expiry, strikes: validStrikes });
  }
  if (expiryStrikes.length === 0) return [];

  const quotes = await quoteOptionChain(connection, symbol, expiryStrikes);
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
