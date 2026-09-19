import { computeSuccessProbability } from "./blackScholesPop.js";
import type { Greeks } from "../ibkr/fetchLiveGreeks.js";

// Approved 2026-09-19 for the Positions P(Δ) / P(d2) columns. Both run 0..1,
// 0 = undesired outcome, 1 = success, where success means a covered call is
// assigned (at a profit) and a cash-secured put is NOT assigned. Only a short
// option leg has a success probability; anything else is null.
//
//   P(Δ)  short call: |delta|          short put: 1 - |delta|
//   P(d2) N(d2) with the streamed IV/underlying price and FRED risk-free rate;
//         threshold = strike (put) or max(strike, stock cost basis) (call).

export interface SuccessProbabilityLeg {
  side: string;
  optionType: string;
  strike: number;
  expiryIsoDate: string;
  /** Weighted-average entry price of the position's open stock leg(s), if any. */
  stockCostBasisPerShare: number | null;
}

export interface LegSuccessProbabilities {
  probabilityByDelta: number | null;
  probabilityByD2: number | null;
}

function todayInEasternIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function wholeDaysBetween(fromIsoDate: string, toIsoDate: string): number {
  return Math.round((Date.parse(`${toIsoDate}T00:00:00Z`) - Date.parse(`${fromIsoDate}T00:00:00Z`)) / 86_400_000);
}

export function computeLegSuccessProbabilities(
  leg: SuccessProbabilityLeg,
  greeks: Greeks,
  riskFreeRate: number | null,
): LegSuccessProbabilities {
  const none = { probabilityByDelta: null, probabilityByD2: null };
  if (leg.side !== "short") return none;
  const isCall = leg.optionType === "call";

  const probabilityByDelta = greeks.delta === null ? null : isCall ? Math.abs(greeks.delta) : 1 - Math.abs(greeks.delta);

  let probabilityByD2: number | null = null;
  if (riskFreeRate !== null && greeks.impliedVolatility && greeks.underlyingPrice) {
    probabilityByD2 = computeSuccessProbability({
      spotPrice: greeks.underlyingPrice,
      thresholdPrice: isCall ? Math.max(leg.strike, leg.stockCostBasisPerShare ?? leg.strike) : leg.strike,
      impliedVolatility: greeks.impliedVolatility,
      daysToExpiry: wholeDaysBetween(todayInEasternIso(), leg.expiryIsoDate),
      riskFreeRate,
    });
  }
  return { probabilityByDelta, probabilityByD2 };
}
