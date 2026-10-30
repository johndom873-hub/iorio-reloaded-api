import type { BaselineForwardAnchor } from "../backtest/engine/baselineSaleSteps.js";
import { impliedVolatilityFromPrice, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";
import { forwardFromAnchor, yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import { contractKey } from "../lib/optionContractKey.js";
import type { OptionQuoteBandQuote } from "./optionQuoteBandQuotes.js";
import { hasPreviousSessionVolumeForOneContract, optionRequoteBand, selectOptionRequoteContracts, type OptionRequoteBand, type OptionRequoteContract } from "./optionRequoteBand.js";

// Which of a ticker's contracts the market quote loop quotes at a cycle (Marcelo 2026-10-15: the re-quoting band; the
// option quote band since it serves both strategies, 2026-10-28). Pure; optionQuoteBandPlanLoader.ts reads its inputs.
//
//   universe          the stored chain's contracts (both rights) of the expiries the ticker's strategy sells, with
//                     enough previous-session volume for one contract under the 20% rule:
//                       CC + Put Ladder   its days-to-expiry range (ladderMinDte–ladderMaxDte)
//                       Vol Farmer v2     the next listed expiry after the session, the only one it sells (a LEAPS is
//                                         quoted when its steps ask for one, volFarmerV2Round.ts)
//                     An expiry the after-close capture has no volume for is taken whole: the rule is lifted on it for
//                     the day (Marcelo 2026-10-30; expiriesWithoutPreviousSessionVolume)
//   last-seen IV      the contract's own IV at its latest quote today (the mid's IV on the expiry's forward, Pluto's
//                     10:00 parity forward moved with the stock: forwardAtSpot); else last night's IBKR IV plus the
//                     expiry's median shift today (own IV today − IBKR IV last night, over the expiry's contracts that
//                     have both); else unknown, and quoted
//   band              Calls: predicted |delta| at the live price inside the strategy's Call range widened (first look of
//                     the day: no band quote yet today); Puts: every strike below the live price, any |delta|
//                     (optionRequoteBand.ts)

export type OptionQuoteBandUniverseContract = Pick<OptionRequoteContract, "expiry" | "strike" | "right">;

/** The expiries a ticker's band covers: the CC + Put Ladder's days-to-expiry range, or Vol Farmer v2's next listed expiry. */
export type OptionQuoteBandExpiryRule = { kind: "days_to_expiry_range"; minDte: number; maxDte: number } | { kind: "next_listed_expiry" };

/** What a ticker's band covers under its strategy: its expiries and the Calls' |delta| range the band widens. */
export interface OptionQuoteBandScope {
  expiryRule: OptionQuoteBandExpiryRule;
  callDeltaRange: OptionRequoteBand;
}

const isoFromYyyymmdd = (expiryYyyymmdd: string): string => `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;

/** The first listed expiry after a session (YYYY-MM-DD), from a stored chain's expiries (YYYYMMDD); null when none is listed. */
export function nextListedExpiryAfter(expirations: readonly string[], sessionIso: string): string | null {
  return expirations.map(isoFromYyyymmdd).reduce<string | null>((next, expiry) => (expiry > sessionIso && (next === null || expiry < next) ? expiry : next), null);
}

/** The rule's expiries over a stored chain (expiries YYYYMMDD), every strike in both rights. Example: on Wed 28 Oct 2026, the next listed expiry is Fri 30 Oct. */
export function optionQuoteBandExpiryContracts(input: { expirations: readonly string[]; strikesByExpiry: ReadonlyMap<string, readonly number[]>; sessionIso: string; expiryRule: OptionQuoteBandExpiryRule }): OptionQuoteBandUniverseContract[] {
  const rule = input.expiryRule;
  const nextListed = rule.kind === "next_listed_expiry" ? nextListedExpiryAfter(input.expirations, input.sessionIso) : null;
  const contracts: OptionQuoteBandUniverseContract[] = [];
  for (const expiryYyyymmdd of input.expirations) {
    const expiry = isoFromYyyymmdd(expiryYyyymmdd);
    if (rule.kind === "next_listed_expiry") {
      if (expiry !== nextListed) continue;
    } else {
      const dte = daysToExpiry(expiry, input.sessionIso);
      if (dte < rule.minDte || dte > rule.maxDte) continue;
    }
    for (const strike of input.strikesByExpiry.get(expiryYyyymmdd) ?? []) for (const right of ["C", "P"] as const) contracts.push({ expiry, strike, right });
  }
  return contracts;
}

/**
 * The expiries the previous session's after-close capture has no volume for (Marcelo 2026-10-30): Pluto lifts the 20% volume
 * rule on them for the day, so a ticker switched on after the capture, a strategy switched to an expiry it did not cover, or a
 * failed capture still trades. An expiry the capture covered keeps the rule, contract by contract. Example: NVDA switched on
 * after the 28 Oct capture has no volume at all on 29 Oct, so its 30 Oct expiry is sold without the rule that day.
 */
export function expiriesWithoutPreviousSessionVolume(expiries: Iterable<string>, previousSessionVolumeByContract: ReadonlyMap<string, number> | null): Set<string> {
  const covered = new Set([...(previousSessionVolumeByContract?.keys() ?? [])].map((key) => key.slice(0, key.indexOf("|"))));
  return new Set([...expiries].filter((expiry) => !covered.has(expiry)));
}

/** The day's universe: the rule's expiries, then the previous session's volume (hasPreviousSessionVolumeForOneContract) on the expiries it covers. */
export function optionQuoteBandDayUniverse(input: Parameters<typeof optionQuoteBandExpiryContracts>[0] & { previousSessionVolumeByContract: ReadonlyMap<string, number> | null }): OptionQuoteBandUniverseContract[] {
  const contracts = optionQuoteBandExpiryContracts(input);
  const lifted = expiriesWithoutPreviousSessionVolume(new Set(contracts.map((contract) => contract.expiry)), input.previousSessionVolumeByContract);
  return contracts.filter((contract) => lifted.has(contract.expiry) || hasPreviousSessionVolumeForOneContract(input.previousSessionVolumeByContract?.get(contractKey(contract)) ?? null));
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

/** A stored quote's own IV (its mid on the forward at the quote's stock price); null without a two-sided quote or a price. */
export function bandQuoteOwnImpliedVolatility(quote: OptionQuoteBandQuote, anchors: ReadonlyMap<string, BaselineForwardAnchor>, clock: LadderClock): number | null {
  if (quote.bid === null || quote.ask === null || !(quote.bid > 0) || !(quote.ask > quote.bid) || quote.stockPrice === null || !(quote.stockPrice > 0)) return null;
  const years = yearsToExpiryAt(quote.expiry, quote.quotedAt, clock);
  if (!(years > 0)) return null;
  const forward = forwardFromAnchor(anchors.get(quote.expiry), quote.stockPrice, years, clock.riskFreeRate);
  return impliedVolatilityFromPrice((quote.bid + quote.ask) / 2, forward, quote.strike, years, clock.riskFreeRate, quote.right === "C");
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

/** Each universe contract's last-seen IV (see the header); null when unknown. */
export function lastSeenImpliedVolatilities(input: { universe: readonly OptionQuoteBandUniverseContract[]; todaysQuotes: readonly OptionQuoteBandQuote[]; overnightImpliedVolatilityByContract: ReadonlyMap<string, number>; anchors: ReadonlyMap<string, BaselineForwardAnchor>; clock: LadderClock }): Map<string, number | null> {
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

export interface OptionQuoteBandPlan {
  contracts: OptionQuoteBandUniverseContract[];
  firstLookOfDay: boolean;
  universeCount: number;
  unknownImpliedVolatilityCount: number;
}

/** The contracts to quote at this cycle, at the live price `stockPrice` and the moment `now`. */
export function planOptionQuoteBand(input: {
  universe: readonly OptionQuoteBandUniverseContract[];
  todaysQuotes: readonly OptionQuoteBandQuote[];
  overnightImpliedVolatilityByContract: ReadonlyMap<string, number>;
  anchors: ReadonlyMap<string, BaselineForwardAnchor>;
  clock: LadderClock;
  now: Date;
  stockPrice: number;
  /** The strategy's Call |delta| range, before the band's margins. */
  callDeltaRange: OptionRequoteBand;
}): OptionQuoteBandPlan {
  const firstLookOfDay = input.todaysQuotes.length === 0;
  const lastSeen = lastSeenImpliedVolatilities(input);
  const universe = input.universe.map((contract) => ({ ...contract, lastSeenImpliedVolatility: lastSeen.get(contractKey(contract)) ?? null }));
  const { toQuote } = selectOptionRequoteContracts({
    universe,
    band: optionRequoteBand(input.callDeltaRange, firstLookOfDay),
    stockPrice: input.stockPrice,
    todayIso: input.clock.todayIso,
    yearsToTodaysClose: yearsToSessionClose(input.now, input.clock.closeMinutesEt),
    riskFreeRate: input.clock.riskFreeRate,
    forwardFor: (expiry, years) => forwardFromAnchor(input.anchors.get(expiry), input.stockPrice, years, input.clock.riskFreeRate),
  });
  return {
    contracts: toQuote.map(({ expiry, strike, right }) => ({ expiry, strike, right })),
    firstLookOfDay,
    universeCount: universe.length,
    unknownImpliedVolatilityCount: universe.filter((contract) => contract.lastSeenImpliedVolatility === null).length,
  };
}
