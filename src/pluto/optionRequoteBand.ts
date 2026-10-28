import { blackScholesDelta, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";
import { contractKey } from "../lib/optionContractKey.js";
import { baselineMaxVolumeShare } from "../backtest/engine/baselineSaleSteps.js";

// Which of a ticker's contracts to quote at a look (Marcelo 2026-10-15, design: the "follow the delta band" rule):
// the Calls whose delta at the look's price, from each contract's last-seen implied volatility, is inside the strategy's
// Call |delta| range widened by a margin, plus every Call whose IV is still unknown; and every Put below the look's price,
// at any delta (Marcelo 2026-10-16: the |delta| range is the Calls'; a ladder Put's strike is at most the rung's cap,
// below the price, so the look sees every Put the backtest would). The universe is fixed each morning: the strategy's
// expiries (optionQuoteBandPlan.ts) and a previous-session volume the 20% rule can sell at least one contract of.
//
//   band, later looks: max(0, bottom − 0.02) … top + 0.10      (0.05–0.30 → 0.03–0.40)
//   band, first look:  max(0, bottom − 0.03) … top + 0.15      (0.05–0.30 → 0.02–0.45)
//   predicted |delta| = |Black-76 delta(forward, strike, T, r, last-seen IV)|, T as the engine's (calendar days ÷ 365;
//                       hours to today's close ÷ 8,760 for a same-day expiry)
//
// Example (8 Oct 2026, 11:00): HOOD at 109.15, the HOOD $107 Put · 9 Oct (1DTE) last seen at IV 63.3% → predicted delta
// about −0.27, inside 0.03–0.40, so it is quoted (it was −0.61 at 10:00, outside the band).

export interface OptionRequoteBand {
  minAbsDelta: number;
  maxAbsDelta: number;
}

/** The band around a strategy's Call |delta| range (approved margins). */
export function optionRequoteBand(callDeltaRange: OptionRequoteBand, firstLookOfDay: boolean): OptionRequoteBand {
  const below = firstLookOfDay ? 0.03 : 0.02;
  const above = firstLookOfDay ? 0.15 : 0.1;
  return { minAbsDelta: Math.max(0, callDeltaRange.minAbsDelta - below), maxAbsDelta: callDeltaRange.maxAbsDelta + above };
}

/** Enough previous-session volume for one contract under the 20% rule (5 or more). */
export function hasPreviousSessionVolumeForOneContract(previousSessionVolume: number | null): boolean {
  return previousSessionVolume !== null && Math.floor(previousSessionVolume * baselineMaxVolumeShare) >= 1;
}

export interface OptionRequoteContract {
  expiry: string;
  strike: number;
  right: "C" | "P";
  /** The implied volatility at the contract's last quote; null when never quoted (new ticker, new expiry, restart). */
  lastSeenImpliedVolatility: number | null;
}

export interface OptionRequoteSelection<Contract extends OptionRequoteContract> {
  toQuote: Contract[];
  /** |delta| predicted per contractKey; absent for an unknown IV. */
  predictedAbsDeltaByKey: Map<string, number>;
}

/** The universe contracts to quote at this look: Calls with predicted |delta| inside the band or IV unknown, every Put below the price. Pure. */
export function selectOptionRequoteContracts<Contract extends OptionRequoteContract>(input: {
  universe: readonly Contract[];
  band: OptionRequoteBand;
  /** The look's stock price: every Put below it is quoted. */
  stockPrice: number;
  todayIso: string;
  /** For a contract expiring today: hours from the look to today's close ÷ 8,760. */
  yearsToTodaysClose: number;
  /** As a fraction (0.05 = 5%). */
  riskFreeRate: number;
  /** The forward for an expiry at the look's price (the caller's choice of source). */
  forwardFor(expiry: string, yearsToExpiry: number): number;
}): OptionRequoteSelection<Contract> {
  const toQuote: Contract[] = [];
  const predictedAbsDeltaByKey = new Map<string, number>();
  for (const contract of input.universe) {
    const isPut = contract.right === "P";
    if (isPut && !(contract.strike < input.stockPrice)) continue;
    const ivKnown = contract.lastSeenImpliedVolatility !== null && contract.lastSeenImpliedVolatility > 0;
    if (!ivKnown) {
      toQuote.push(contract);
      continue;
    }
    const dte = daysToExpiry(contract.expiry, input.todayIso);
    const years = dte === 0 ? input.yearsToTodaysClose : yearsBetweenIsoDates(input.todayIso, contract.expiry);
    if (!(years > 0)) continue;
    const delta = blackScholesDelta(input.forwardFor(contract.expiry, years), contract.strike, years, input.riskFreeRate, contract.lastSeenImpliedVolatility!, contract.right === "C");
    const absDelta = Math.abs(delta);
    predictedAbsDeltaByKey.set(contractKey(contract), absDelta);
    if (isPut || (absDelta >= input.band.minAbsDelta - 1e-12 && absDelta <= input.band.maxAbsDelta + 1e-12)) toQuote.push(contract);
  }
  return { toQuote, predictedAbsDeltaByKey };
}
