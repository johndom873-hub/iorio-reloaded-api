import { strikeStepAroundSpot } from "./daySignalsContractSet.js";
import { contractKey, liveQuoteMaxContracts, type ContractRef } from "./signalsLiveScoring.js";

// Which contracts the Signals modal holds live IBKR lines on while its option chain is open (approved
// 2026-09-29): the selected expiry's out-of-the-money contracts nearest the live spot, so the chain shows live
// quotes where you would actually trade, not on whatever the 9:30 snapshot happened to rank. Open legs come
// first (Roll Signals), then puts (strike at or below spot) and calls (at or above) alternately, nearest
// first, up to the cap. The set is re-made when the spot has moved two strike steps from where it was chosen.

export const liveChainRecenterStrikeSteps = 2;

export interface LiveChainContractsInput {
  expiry: string; // ISO date
  /** The listed strike grid of `expiry`. */
  strikes: number[];
  spotPrice: number;
  heldLegs: ContractRef[];
  maxContracts?: number;
}

export function selectLiveChainContracts(input: LiveChainContractsInput): ContractRef[] {
  const maxContracts = input.maxContracts ?? liveQuoteMaxContracts;
  const selected: ContractRef[] = [];
  const seen = new Set<string>();
  const add = (ref: ContractRef) => {
    const key = contractKey(ref);
    if (seen.has(key) || selected.length >= maxContracts) return;
    seen.add(key);
    selected.push(ref);
  };
  for (const leg of input.heldLegs) add({ expiry: leg.expiry, strike: leg.strike, right: leg.right });

  const putStrikes = input.strikes.filter((strike) => strike <= input.spotPrice).sort((a, b) => b - a);
  const callStrikes = input.strikes.filter((strike) => strike >= input.spotPrice).sort((a, b) => a - b);
  for (let index = 0; index < Math.max(putStrikes.length, callStrikes.length); index += 1) {
    if (index < putStrikes.length) add({ expiry: input.expiry, strike: putStrikes[index]!, right: "P" });
    if (index < callStrikes.length) add({ expiry: input.expiry, strike: callStrikes[index]!, right: "C" });
  }
  return selected;
}

/** True once the spot is at least liveChainRecenterStrikeSteps listed strike steps away from the spot the live set was chosen at. False when the grid gives no step (spot outside it). */
export function shouldRecenterLiveChain(anchorSpotPrice: number, spotPrice: number, strikes: number[]): boolean {
  const step = strikeStepAroundSpot(strikes, anchorSpotPrice);
  if (step === null || !(step > 0)) return false;
  return Math.abs(spotPrice - anchorSpotPrice) >= liveChainRecenterStrikeSteps * step;
}
