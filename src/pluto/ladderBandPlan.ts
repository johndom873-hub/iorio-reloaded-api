import type { BaselineForwardAnchor } from "../backtest/engine/baselineSaleSteps.js";
import { forwardAtSpot, impliedVolatilityFromPrice, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";
import { yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import { contractKey } from "../lib/signalsLiveScoring.js";
import type { LadderBandQuote } from "./ladderBandQuotes.js";
import { isInLadderUniverse, ladderRequoteBand, selectLadderRequoteContracts, type LadderRequoteContract } from "./ladderRequoteBand.js";
import type { PlutoSettings } from "./settingsStore.js";

// Which of a ladder ticker's contracts the Day Signals loop quotes at a cycle (Marcelo 2026-10-15: the re-quoting band,
// run inside the Day Signals loop beside Signals' own contracts). Pure; ladderBandPlanLoader.ts reads its inputs.
//
//   universe          the stored chain's 1–45 DTE contracts (both rights) with enough previous-session volume for one
//                     contract under the 20% rule
//   last-seen IV      the contract's own IV at its latest quote today (the mid's IV on the expiry's forward, Pluto's
//                     10:00 parity forward moved with the stock: forwardAtSpot); else last night's IBKR IV plus the
//                     expiry's median shift today (own IV today − IBKR IV last night, over the expiry's contracts that
//                     have both); else unknown, and quoted
//   band              predicted |delta| at the live price inside the ladder's range widened (first look of the day:
//                     no band quote yet today)

export type LadderUniverseContract = Pick<LadderRequoteContract, "expiry" | "strike" | "right">;

/** The ladder's days-to-expiry range over a stored chain (expiries YYYYMMDD), every strike in both rights. */
export function ladderDteRangeContracts(input: { expirations: readonly string[]; strikesByExpiry: ReadonlyMap<string, readonly number[]>; todayIso: string; settings: Pick<PlutoSettings, "ladderMinDte" | "ladderMaxDte"> }): LadderUniverseContract[] {
  const contracts: LadderUniverseContract[] = [];
  for (const expiryYyyymmdd of input.expirations) {
    const expiry = `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
    const dte = daysToExpiry(expiry, input.todayIso);
    if (dte < input.settings.ladderMinDte || dte > input.settings.ladderMaxDte) continue;
    for (const strike of input.strikesByExpiry.get(expiryYyyymmdd) ?? []) for (const right of ["C", "P"] as const) contracts.push({ expiry, strike, right });
  }
  return contracts;
}

/** The day's universe: the days-to-expiry range, then the previous session's volume (isInLadderUniverse). */
export function ladderDayUniverse(input: Parameters<typeof ladderDteRangeContracts>[0] & { previousSessionVolumeByContract: ReadonlyMap<string, number> }): LadderUniverseContract[] {
  return ladderDteRangeContracts(input).filter((contract) => isInLadderUniverse(contract, input.previousSessionVolumeByContract.get(contractKey(contract)) ?? null, input.settings, input.todayIso));
}

export interface LadderClock {
  todayIso: string;
  /** Today's close, minutes after midnight Eastern. */
  closeMinutesEt: number;
  /** As a fraction (0.05 = 5%). */
  riskFreeRate: number;
}

/** The engine's T: calendar days ÷ 365, or for a same-day expiry the hours from `at` to today's close ÷ 8,760. */
function yearsToExpiryAt(expiry: string, at: Date, clock: LadderClock): number {
  return daysToExpiry(expiry, clock.todayIso) <= 0 ? yearsToSessionClose(at, clock.closeMinutesEt) : yearsBetweenIsoDates(clock.todayIso, expiry);
}

/** The expiry's forward at a stock price: Pluto's 10:00 anchor moved with the stock, else the price grown at the risk-free rate. */
export function ladderForward(anchor: BaselineForwardAnchor | undefined, stockPrice: number, yearsToExpiry: number, riskFreeRate: number): number {
  return anchor ? forwardAtSpot(anchor.forward, anchor.spotPrice, stockPrice) : stockPrice * Math.exp(riskFreeRate * yearsToExpiry);
}

/** A stored quote's own IV (its mid on the forward at the quote's stock price); null without a two-sided quote or a price. */
export function bandQuoteOwnImpliedVolatility(quote: LadderBandQuote, anchors: ReadonlyMap<string, BaselineForwardAnchor>, clock: LadderClock): number | null {
  if (quote.bid === null || quote.ask === null || !(quote.bid > 0) || !(quote.ask > quote.bid) || quote.stockPrice === null || !(quote.stockPrice > 0)) return null;
  const years = yearsToExpiryAt(quote.expiry, quote.quotedAt, clock);
  if (!(years > 0)) return null;
  const forward = ladderForward(anchors.get(quote.expiry), quote.stockPrice, years, clock.riskFreeRate);
  return impliedVolatilityFromPrice((quote.bid + quote.ask) / 2, forward, quote.strike, years, clock.riskFreeRate, quote.right === "C");
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

/** Each universe contract's last-seen IV (see the header); null when unknown. */
export function lastSeenImpliedVolatilities(input: { universe: readonly LadderUniverseContract[]; todaysQuotes: readonly LadderBandQuote[]; overnightImpliedVolatilityByContract: ReadonlyMap<string, number>; anchors: ReadonlyMap<string, BaselineForwardAnchor>; clock: LadderClock }): Map<string, number | null> {
  const ownToday = new Map<string, number>();
  for (const quote of input.todaysQuotes) {
    const impliedVolatility = bandQuoteOwnImpliedVolatility(quote, input.anchors, input.clock);
    if (impliedVolatility !== null) ownToday.set(contractKey(quote), impliedVolatility);
  }
  const shiftsByExpiry = new Map<string, number[]>();
  for (const [key, impliedVolatility] of ownToday) {
    const overnight = input.overnightImpliedVolatilityByContract.get(key);
    if (overnight === undefined) continue;
    const expiry = key.split("|")[0]!;
    shiftsByExpiry.set(expiry, [...(shiftsByExpiry.get(expiry) ?? []), impliedVolatility - overnight]);
  }
  const shiftByExpiry = new Map([...shiftsByExpiry].map(([expiry, shifts]) => [expiry, median(shifts)]));
  const result = new Map<string, number | null>();
  for (const contract of input.universe) {
    const key = contractKey(contract);
    const today = ownToday.get(key);
    if (today !== undefined) {
      result.set(key, today);
      continue;
    }
    const overnight = input.overnightImpliedVolatilityByContract.get(key);
    const shifted = overnight === undefined ? null : overnight + (shiftByExpiry.get(contract.expiry) ?? 0);
    result.set(key, shifted !== null && shifted > 0 ? shifted : null);
  }
  return result;
}

export interface LadderBandPlan {
  contracts: LadderUniverseContract[];
  firstLookOfDay: boolean;
  universeCount: number;
  unknownImpliedVolatilityCount: number;
}

/** The contracts to quote at this cycle, at the live price `stockPrice` and the moment `now`. */
export function planLadderBand(input: {
  universe: readonly LadderUniverseContract[];
  todaysQuotes: readonly LadderBandQuote[];
  overnightImpliedVolatilityByContract: ReadonlyMap<string, number>;
  anchors: ReadonlyMap<string, BaselineForwardAnchor>;
  clock: LadderClock;
  now: Date;
  stockPrice: number;
  deltaRange: Pick<PlutoSettings, "ladderMinAbsDelta" | "ladderMaxAbsDelta">;
}): LadderBandPlan {
  const firstLookOfDay = input.todaysQuotes.length === 0;
  const lastSeen = lastSeenImpliedVolatilities(input);
  const universe = input.universe.map((contract) => ({ ...contract, lastSeenImpliedVolatility: lastSeen.get(contractKey(contract)) ?? null }));
  const { toQuote } = selectLadderRequoteContracts({
    universe,
    band: ladderRequoteBand(input.deltaRange, firstLookOfDay),
    todayIso: input.clock.todayIso,
    yearsToTodaysClose: yearsToSessionClose(input.now, input.clock.closeMinutesEt),
    riskFreeRate: input.clock.riskFreeRate,
    forwardFor: (expiry, years) => ladderForward(input.anchors.get(expiry), input.stockPrice, years, input.clock.riskFreeRate),
  });
  return {
    contracts: toQuote.map(({ expiry, strike, right }) => ({ expiry, strike, right })),
    firstLookOfDay,
    universeCount: universe.length,
    unknownImpliedVolatilityCount: universe.filter((contract) => contract.lastSeenImpliedVolatility === null).length,
  };
}
