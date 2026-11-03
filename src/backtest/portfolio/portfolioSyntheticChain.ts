import { blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import { contractKey } from "../../lib/optionContractKey.js";
import type { SymbolFileQuote } from "../engine/backtestSymbolFile.js";
import type { LeapsCallQuoteSource } from "../engine/volFarmerV4Steps.js";
import { impliedVolatilityRatioNear, nearestObservedContract, quoteLikeObserved, standardDeviationsOf, type ObservedChainDay } from "./portfolioObservedChain.js";

// The portfolio simulator's option chains (D4, Marcelo 2026-11-03): on a simulated day there is no recorded chain, so the
// look reads one priced with Black-Scholes on the forward (no dividends) at the ticker's strike spacing. The day's next
// expiry is priced at IBKR's 30-day IV × u (u: how much higher a same-day Call's own IV ran than the 30-day IV in the
// ticker's backtest), the LEAPS at the 30-day IV. With an observed day of the ticker's own chain (portfolioObservedChain.ts)
// the next expiry is priced, quoted and traded like it instead, u then standing in only where the observed day has no IV
// to read; without one, and for the LEAPS, quotes are a cent either side of the mid (the steps need an ask above the bid;
// the lab and Pluto fill at the mid) with a volume no order reaches.

/** The volume a synthetic contract shows for the previous session without an observed day: no order comes near 20% of it. */
export const syntheticContractVolume = 1_000_000_000;
/** A synthetic quote's size, bid and ask: the LEAPS is capped at its ask's size in the lab. */
const syntheticQuoteSize = 1_000_000;

/** A strike grid at `spacing` around `price`, as many strikes as cover `price` × (1 ± `halfWidth`), at most `maxStrikes` a side. */
export function strikeGrid(price: number, spacing: number, halfWidth: number, maxStrikes = 120): number[] {
  const centre = Math.round(price / spacing) * spacing;
  const strikesASide = Math.min(maxStrikes, Math.max(5, Math.ceil((price * halfWidth) / spacing)));
  const strikes: number[] = [];
  for (let step = -strikesASide; step <= strikesASide; step++) {
    const strike = Math.round((centre + step * spacing) * 100) / 100;
    if (strike > 0) strikes.push(strike);
  }
  return strikes;
}

/** The mid of a contract priced on the forward, to the cent: null below 2 cents, a contract quoted at no bid. */
export function syntheticMid(stockPrice: number, strike: number, yearsToExpiry: number, riskFreeRate: number, volatility: number, isCall: boolean): number | null {
  const forward = stockPrice * Math.exp(riskFreeRate * yearsToExpiry);
  const mid = Math.round(blackScholesPriceOnForward(forward, strike, yearsToExpiry, riskFreeRate, volatility, isCall) * 100) / 100;
  return mid >= 0.02 ? mid : null;
}

/**
 * Calls and Puts of one expiry on a strike grid wide enough for 5 standard deviations to the expiry (at least ±3%), with
 * each contract's previous-session volume by contractKey. With an observed day, each strike is priced at the 30-day IV ×
 * the IV ratio of the observed contract nearest it with one (standard deviations on the 30-day IV), and quotes and trades
 * like the observed contract nearest it; a strike past the observed ones is not listed.
 */
export function syntheticExpiryChain(input: { expiry: string; stockPrice: number; yearsToExpiry: number; riskFreeRate: number; volatility: number; strikeSpacing: number; observed?: { day: ObservedChainDay; thirtyDayVolatility: number } }): { quotes: SymbolFileQuote[]; previousSessionVolumeByContract: Map<string, number> } {
  const { expiry, stockPrice, yearsToExpiry, riskFreeRate, volatility, strikeSpacing, observed } = input;
  const halfWidth = Math.max(0.03, 5 * volatility * Math.sqrt(Math.max(yearsToExpiry, 1e-6)));
  const quotes: SymbolFileQuote[] = [];
  const previousSessionVolumeByContract = new Map<string, number>();
  let strikes = strikeGrid(stockPrice, strikeSpacing, halfWidth);
  if (observed !== undefined) {
    // Only the strikes within the observed ones' reach can be listed (nearestObservedContract): the grid is cut to them,
    // a little wide, before each strike is checked as it always is.
    const reach = observedReach(observed.day);
    if (reach === null) return { quotes, previousSessionVolumeByContract };
    const scale = observed.thirtyDayVolatility * Math.sqrt(yearsToExpiry);
    const lowest = stockPrice * Math.exp(reach.low * scale) * (1 - 1e-6);
    const highest = stockPrice * Math.exp(reach.high * scale) * (1 + 1e-6);
    strikes = strikes.filter((strike) => strike >= lowest && strike <= highest);
  }
  for (const strike of strikes) {
    for (const right of ["C", "P"] as const) {
      if (observed === undefined) {
        const mid = syntheticMid(stockPrice, strike, yearsToExpiry, riskFreeRate, volatility, right === "C");
        if (mid === null) continue;
        const quote = { expiry, strike, right, bid: Math.round((mid - 0.01) * 100) / 100, ask: Math.round((mid + 0.01) * 100) / 100, bidSize: syntheticQuoteSize, askSize: syntheticQuoteSize };
        quotes.push(quote);
        previousSessionVolumeByContract.set(contractKey(quote), syntheticContractVolume);
        continue;
      }
      const contracts = right === "C" ? observed.day.calls : observed.day.puts;
      const standardDeviations = standardDeviationsOf(strike, stockPrice, observed.thirtyDayVolatility, yearsToExpiry);
      const nearest = nearestObservedContract(contracts, standardDeviations);
      if (nearest === null) continue;
      const ratio = impliedVolatilityRatioNear(contracts, standardDeviations);
      const mid = syntheticMid(stockPrice, strike, yearsToExpiry, riskFreeRate, ratio === null ? volatility : observed.thirtyDayVolatility * ratio, right === "C");
      if (mid === null) continue;
      const like = quoteLikeObserved(mid, nearest)!;
      const quote = { expiry, strike, right, bid: like.bid, ask: like.ask, bidSize: syntheticQuoteSize, askSize: syntheticQuoteSize };
      quotes.push(quote);
      if (like.previousSessionVolume > 0) previousSessionVolumeByContract.set(contractKey(quote), like.previousSessionVolume);
    }
  }
  return { quotes, previousSessionVolumeByContract };
}

/** The standard deviations an observed day's contracts reach, Calls and Puts together, an outermost gap past each end; null with none. */
function observedReach(day: ObservedChainDay): { low: number; high: number } | null {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const contracts of [day.calls, day.puts]) {
    if (contracts.length === 0) continue;
    const first = contracts[0]!.standardDeviations;
    const last = contracts[contracts.length - 1]!.standardDeviations;
    const firstGap = contracts.length > 1 ? contracts[1]!.standardDeviations - first : 0;
    const lastGap = contracts.length > 1 ? last - contracts[contracts.length - 2]!.standardDeviations : 0;
    low = Math.min(low, first - firstGap);
    high = Math.max(high, last + lastGap);
  }
  return low === Number.POSITIVE_INFINITY ? null : { low, high };
}

/** The third Friday of a month ("2027-06"): the standard monthly expiry. */
export function thirdFridayOf(yearMonth: string): string {
  const first = new Date(`${yearMonth}-01T00:00:00Z`);
  const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
  return `${yearMonth}-${String(firstFriday + 14).padStart(2, "0")}`;
}

/** The monthly expiries 5 to 25 months after a month ("2026-11"), worked out once per month. */
const leapsExpiriesByMonth = new Map<string, readonly string[]>();
function leapsExpiriesOfMonth(yearMonth: string): readonly string[] {
  let expiries = leapsExpiriesByMonth.get(yearMonth);
  if (expiries === undefined) {
    const [year, month] = yearMonth.split("-").map(Number) as [number, number];
    expiries = Array.from({ length: 21 }, (_, index) => thirdFridayOf(new Date(Date.UTC(year, month - 1 + 5 + index, 1)).toISOString().slice(0, 7)));
    leapsExpiriesByMonth.set(yearMonth, expiries);
  }
  return expiries;
}

/**
 * The long-dated Calls a LEAPS is chosen from: the monthly expiries from 5 to 25 months out, Calls from half the price to
 * 1.5 times it, at the larger of the strike spacing and 2.5% of the price (rounded to the spacing), priced at the 30-day IV.
 */
export function syntheticLeapsSource(input: { todayIso: string; stockPrice: number; riskFreeRate: number; volatility: number; strikeSpacing: number; yearsToExpiry(expiry: string): number }): LeapsCallQuoteSource {
  const { todayIso, stockPrice, riskFreeRate, volatility, strikeSpacing } = input;
  const expiries = leapsExpiriesOfMonth(todayIso.slice(0, 7));
  const spacing = Math.max(strikeSpacing, Math.round((stockPrice * 0.025) / strikeSpacing) * strikeSpacing);
  const cache = new Map<string, SymbolFileQuote[]>();
  return {
    listedExpiries: () => expiries,
    quotesOf(expiry) {
      let quotes = cache.get(expiry);
      if (quotes === undefined) {
        const yearsToExpiry = input.yearsToExpiry(expiry);
        quotes = [];
        for (const strike of strikeGrid(stockPrice, spacing, 0.5, 60)) {
          const mid = syntheticMid(stockPrice, strike, yearsToExpiry, riskFreeRate, volatility, true);
          if (mid !== null) quotes.push({ expiry, strike, right: "C", bid: Math.round((mid - 0.01) * 100) / 100, ask: Math.round((mid + 0.01) * 100) / 100, bidSize: syntheticQuoteSize, askSize: syntheticQuoteSize });
        }
        cache.set(expiry, quotes);
      }
      return quotes;
    },
  };
}
