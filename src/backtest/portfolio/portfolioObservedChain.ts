import { impliedVolatilityFromPrice } from "../../lib/impliedVolatilitySurface.js";
import { contractKey } from "../../lib/optionContractKey.js";
import type { SymbolFileEndOfDayRow, SymbolFileQuote } from "../engine/backtestSymbolFile.js";

// The portfolio simulator's observed chains (Marcelo 2026-11-03): a simulated chain prices, quotes and trades like one of
// the ticker's own recent days. Each observed day keeps, for every contract of the expiry v4 reads (the next one), where
// its strike stood (standard deviations to the expiry on the 30-day IV), its own IV ÷ the 30-day IV, half its spread as a
// share of its mid, and its previous-session volume. A simulated day takes one observed day with the same days to the
// expiry, and each synthetic strike takes those of the observed contract standing nearest it: its mid is priced at the
// simulated 30-day IV × that IV ratio (the observed day's skew and same-day premium over the 30-day IV), its bid and ask
// are the mid ∓ that share, its volume that volume. So v4's own quote rule (bid at least $0.05, an ask above it), spread
// limit, delta band and 20% volume cap act on the simulated chain as on the real one, the cap on the order the pot makes.
// Liquidity example: EEM at $66.00,
// 30-day IV 20%, 6 hours to a same-day expiry (σ√T = 0.0052): the $66.50 Call stands ln(66.5 ÷ 66) ÷ 0.0052 = 1.44
// standard deviations out; quoted 0.01 / 0.04 on the observed day (half-spread 0.6 of the mid) and 120 contracts traded
// the session before, a synthetic mid of $0.05 quotes 0.02 / 0.08 (no bid of $0.05: rejected), and a mid of $0.20 quotes
// 0.08 / 0.32 with at most 24 contracts sold.

export interface ObservedContract {
  /** ln(strike ÷ price) ÷ (30-day IV × √years to the expiry). */
  standardDeviations: number;
  /** The contract's own IV (from its mid, on the forward) ÷ the 30-day IV; null with no two-sided quote or no IV from the mid. */
  impliedVolatilityRatio: number | null;
  /** (ask − bid) ÷ (ask + bid); null with no bid above 0 or no ask above the bid. */
  halfSpreadShare: number | null;
  /** The previous session's volume; 0 with none recorded. */
  previousSessionVolume: number;
}

export interface ObservedChainDay {
  dateIso: string;
  /** Calendar days from the day to the expiry read. */
  daysToExpiry: number;
  /** By standard deviations, ascending. */
  calls: ObservedContract[];
  puts: ObservedContract[];
}

const calendarDaysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

export const standardDeviationsOf = (strike: number, stockPrice: number, volatility: number, yearsToExpiry: number) => Math.log(strike / stockPrice) / (volatility * Math.sqrt(yearsToExpiry));

/** One day of the ticker's own chain, as v4 reads it (loadNextCallExpiryDay): the expiry's 10:00 quotes and the previous session's volumes. */
export function observedChainDayOf(input: { dateIso: string; expiry: string; quotes: readonly SymbolFileQuote[]; previousEndOfDay: readonly SymbolFileEndOfDayRow[]; stockPrice: number; impliedVolatility: number; yearsToExpiry: number; riskFreeRate: number }): ObservedChainDay | null {
  if (!(input.yearsToExpiry > 0) || !(input.impliedVolatility > 0) || !(input.stockPrice > 0)) return null;
  const volumeByContract = new Map(input.previousEndOfDay.flatMap((row) => (row.volume === null ? [] : [[contractKey(row), row.volume] as const])));
  const forward = input.stockPrice * Math.exp(input.riskFreeRate * input.yearsToExpiry);
  const observedOf = (right: "C" | "P") =>
    input.quotes
      .filter((quote) => quote.expiry === input.expiry && quote.right === right && quote.strike > 0)
      .map<ObservedContract>((quote) => {
        const twoSided = quote.bid !== null && quote.ask !== null && quote.bid > 0 && quote.ask > quote.bid;
        const impliedVolatility = twoSided ? impliedVolatilityFromPrice((quote.bid! + quote.ask!) / 2, forward, quote.strike, input.yearsToExpiry, input.riskFreeRate, right === "C") : null;
        return {
          standardDeviations: standardDeviationsOf(quote.strike, input.stockPrice, input.impliedVolatility, input.yearsToExpiry),
          impliedVolatilityRatio: impliedVolatility === null ? null : impliedVolatility / input.impliedVolatility,
          halfSpreadShare: twoSided ? (quote.ask! - quote.bid!) / (quote.ask! + quote.bid!) : null,
          previousSessionVolume: volumeByContract.get(contractKey(quote)) ?? 0,
        };
      })
      .sort((a, b) => a.standardDeviations - b.standardDeviations);
  const calls = observedOf("C");
  const puts = observedOf("P");
  if (calls.length === 0 && puts.length === 0) return null;
  return { dateIso: input.dateIso, daysToExpiry: calendarDaysBetween(input.dateIso, input.expiry), calls, puts };
}

/** The observed days with the days to expiry nearest `daysToExpiry` (the same where there are any). */
export function observedDaysNearest(days: readonly ObservedChainDay[], daysToExpiry: number): ObservedChainDay[] {
  let nearest = Number.POSITIVE_INFINITY;
  for (const day of days) nearest = Math.min(nearest, Math.abs(day.daysToExpiry - daysToExpiry));
  return days.filter((day) => Math.abs(day.daysToExpiry - daysToExpiry) === nearest);
}

/**
 * The observed contract standing nearest `standardDeviations`; null beyond the listed strikes (more than the outermost
 * gap past the first or last one), where the real chain lists nothing.
 */
export function nearestObservedContract(contracts: readonly ObservedContract[], standardDeviations: number): ObservedContract | null {
  if (contracts.length === 0) return null;
  const first = contracts[0]!;
  const last = contracts[contracts.length - 1]!;
  const firstGap = contracts.length > 1 ? contracts[1]!.standardDeviations - first.standardDeviations : 0;
  const lastGap = contracts.length > 1 ? last.standardDeviations - contracts[contracts.length - 2]!.standardDeviations : 0;
  if (standardDeviations < first.standardDeviations - firstGap || standardDeviations > last.standardDeviations + lastGap) return null;
  let low = 0;
  let high = contracts.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (contracts[middle]!.standardDeviations <= standardDeviations) low = middle;
    else high = middle;
  }
  return Math.abs(contracts[low]!.standardDeviations - standardDeviations) <= Math.abs(contracts[high]!.standardDeviations - standardDeviations) ? contracts[low]! : contracts[high]!;
}

/** The IV ratio of the observed contract with one standing nearest `standardDeviations`; null when none has one. */
export function impliedVolatilityRatioNear(contracts: readonly ObservedContract[], standardDeviations: number): number | null {
  let ratio: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const contract of contracts) {
    if (contract.impliedVolatilityRatio === null) continue;
    const away = Math.abs(contract.standardDeviations - standardDeviations);
    if (away < distance) [ratio, distance] = [contract.impliedVolatilityRatio, away];
  }
  return ratio;
}

const roundedToCents = (value: number) => Math.round(value * 100) / 100;

/**
 * A synthetic contract quoted as its nearest observed one: bid and ask the mid ∓ the observed half-spread share (to the
 * cent, the ask at least a cent above the bid), no bid where the observed one had none (its ask then plays no part), and
 * the observed volume; null where the real chain lists no strike.
 */
export function quoteLikeObserved(mid: number, observed: ObservedContract | null): { bid: number | null; ask: number; previousSessionVolume: number } | null {
  if (observed === null) return null;
  if (observed.halfSpreadShare === null) return { bid: null, ask: roundedToCents(mid * 2), previousSessionVolume: observed.previousSessionVolume };
  const bid = Math.max(0, roundedToCents(mid * (1 - observed.halfSpreadShare)));
  const ask = Math.max(roundedToCents(mid * (1 + observed.halfSpreadShare)), bid + 0.01);
  return { bid, ask: roundedToCents(ask), previousSessionVolume: observed.previousSessionVolume };
}

// The volatility anchor (Marcelo 2026-11-03): a same-day Call's IV ÷ IBKR's 30-day IV moves with how high the 30-day IV
// stands against its own last 60 sessions (its elevation): an earnings run-up lifts the 30-day IV, not a same-day IV
// expiring before the report (CSCO at-the-money: 1.70 at 0.9–1.1×, 1.25 at 1.25–1.5×), and a market-wide shock lifts
// both, SPY's more. So a chain's strikes and IVs are read against an anchor, the 30-day IV × the ticker's factor at the
// day's elevation, and carried between days of any elevation on it. Example: CSCO's factors 1.00 at 1.0× and 0.74 at
// 1.37×: a 30-day IV of 30% at 1.0× and of 40% at 1.37× anchor at 30% and 29.6%, a same-day Call with an IV ratio of 1.70
// to the anchor then priced at 51% and 50%.

/** The sessions the elevation's median is taken over, and the fewest of them with a 30-day IV it is read from. */
export const elevationSessions = 60;
const elevationMinimumSessions = 40;

/** The 30-day IV ÷ the median of the 30-day IVs of the sessions before it (the latest `elevationSessions`); null with fewer than 40. */
export function thirtyDayIvElevation(impliedVolatility: number, sessionsBefore: readonly (number | null)[]): number | null {
  const known = sessionsBefore.slice(-elevationSessions).filter((value): value is number => value !== null && value > 0);
  if (known.length < elevationMinimumSessions || !(impliedVolatility > 0)) return null;
  const sorted = known.sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return impliedVolatility / (sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** The elevation bands the factor is read in, and the fewest days a band needs. */
const elevationBandEdges = [0.9, 1.0, 1.1, 1.25, 1.5];
const anchorBandMinimumDays = 10;

/** The anchor factor by elevation: points at each band's median elevation, ascending. */
export type AnchorCurve = readonly { elevation: number; factor: number }[];

/**
 * A ticker's anchor factors, from its same-day expiries: each band's median at-the-money IV ratio (the observed Call
 * nearest the price, its IV ÷ the 30-day IV) ÷ the median over every day, at the band's median elevation; a band with
 * fewer than 10 days left out. Empty with no day: the factor is then 1.
 */
export function anchorCurveOf(samples: readonly { elevation: number; atMoneyRatio: number }[]): AnchorCurve {
  const medianOf = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  if (samples.length === 0) return [];
  const overall = medianOf(samples.map((sample) => sample.atMoneyRatio));
  const bands = [Number.NEGATIVE_INFINITY, ...elevationBandEdges, Number.POSITIVE_INFINITY];
  const curve: { elevation: number; factor: number }[] = [];
  for (let band = 0; band < bands.length - 1; band++) {
    const inBand = samples.filter((sample) => sample.elevation >= bands[band]! && sample.elevation < bands[band + 1]!);
    if (inBand.length < anchorBandMinimumDays) continue;
    curve.push({ elevation: medianOf(inBand.map((sample) => sample.elevation)), factor: medianOf(inBand.map((sample) => sample.atMoneyRatio)) / overall });
  }
  return curve;
}

/** The factor at an elevation: linear between the curve's points, flat beyond its ends; 1 with no curve or no elevation. */
export function anchorFactorAt(curve: AnchorCurve, elevation: number | null): number {
  if (curve.length === 0 || elevation === null) return 1;
  if (elevation <= curve[0]!.elevation) return curve[0]!.factor;
  const last = curve[curve.length - 1]!;
  if (elevation >= last.elevation) return last.factor;
  const upper = curve.findIndex((point) => point.elevation >= elevation);
  const below = curve[upper - 1]!;
  const above = curve[upper]!;
  return below.factor + ((above.factor - below.factor) * (elevation - below.elevation)) / (above.elevation - below.elevation);
}

/** The at-the-money IV ratio of an observed day: its Call nearest the price with an IV. */
export function atMoneyRatioOf(day: ObservedChainDay): number | null {
  return impliedVolatilityRatioNear(day.calls, 0);
}

/** An observed day read against its anchor (the 30-day IV × `factor`) instead of the 30-day IV: positions and IV ratios ÷ the factor. */
export function observedAgainstAnchor(day: ObservedChainDay, factor: number): ObservedChainDay {
  const rescaled = (contracts: readonly ObservedContract[]) => contracts.map((contract) => ({ ...contract, standardDeviations: contract.standardDeviations / factor, impliedVolatilityRatio: contract.impliedVolatilityRatio === null ? null : contract.impliedVolatilityRatio / factor }));
  return { ...day, calls: rescaled(day.calls), puts: rescaled(day.puts) };
}
