// The put ladder on a cash reserve of the retired CC + Put Ladder (baseline putsWhenNoCall "reserve_ladder", Marcelo
// 2026-10-14), as its past sessions stored it for the screens to read back (sessionLadderFigures.ts,
// backtestSessionStore.ts). The entries (Covered Calls' shares, or Cash-Secured Puts' collateral until they are
// assigned) got ladderSharesPct% of the base (at cost) and the rest was the reserve R0; the base was the larger of the
// account value the cycle started with and today's (in a session of per-ticker pots, the ticker's share of that). When
// held shares got no call, puts were sold on the reserve, the strike capped by how much of it was committed:
//
//   K_max = A − (A − F) × (U + Q) ÷ R0
//     A  = the cycle's break-even per share (the platform's: shares' cost less the cycle's net premium, ÷ shares), or
//          with ladderTop "price" the lower of it and today's price; with ladderPace "one_open", no rung while a ladder
//          put is open
//     F  = the floor: the average cost of the shares held (weighted by the shares of each purchase or assignment, on
//          today's price scale) × (1 − S). It follows the holdings, falling as lower rungs are assigned, and never rises
//          with the market (Marcelo 2026-10-15: the Puts are there to lower the break-even); no shares held, no rung
//     S  = the stock shock: fixed, or the deepest fall from a running peak in the adjusted closes of the
//          ladderShockLookbackYears before the cycle started, kept within ladderShockMinPct–ladderShockMaxPct; with
//          under a year of closes there (a new listing), ladderShockNoHistoryPct
//     U  = the reserve committed: shares held at cost + open puts' collateral (strike × shares) − the shares' budget,
//          at least 0 (shares called away free it again)
//     Q  = this rung's collateral: min(R0 ÷ ladderRungs, R0 − U)
//
// Example: break-even $100, shares' average cost $104, S 70% (F $31.20), R0 $100,000 in 5 rungs, nothing committed:
// K_max = 100 − 68.80 × 0.2 = $86.24; with $15,000 committed after an assignment, the average cost down to $98.20
// (F $29.46) and the break-even to $95.50: 95.50 − 66.04 × 0.35 = $72.39. The last rung's cap is the floor itself.

/**
 * The rung a ladder put reaches (Marcelo 2026-10-20, the price chart's numbered rungs): slices = (U + Q) ÷ (R0 ÷ rungs), the
 * reserve's slices it fills up to; its number is that rounded up, 1 to rungs (a hair over a whole slice, from rounding,
 * stays on it). Example: R0 $51,298 in 2 rungs ($25,649 each), $11,305 already committed: (11,305 + 25,649) ÷ 25,649 =
 * 1.44 slices, rung 2. Null without a reserve or a rung count.
 */
export function ladderRungReached(input: { committed: number; rungCollateral: number; reserve: number; rungs: number }): { rungNumber: number; slices: number } | null {
  const { committed, rungCollateral, reserve, rungs } = input;
  if (!(reserve > 0) || !(rungs >= 1)) return null;
  const slices = (committed + rungCollateral) / (reserve / rungs);
  return { rungNumber: Math.min(rungs, Math.max(1, Math.ceil(slices - 0.005))), slices };
}

/** Why no ladder put can be sold at a look, before its orders: the ladder's puts off, no free lot (every lot has a call), a put open with ladderPace "one_open", or no cap. */
export type LadderPutBlock = "ladder_puts_off" | "every_lot_has_a_call" | "a_put_is_open" | "no_cap";

export interface LadderLevels {
  /** A, F and S; F null with no shares held. */
  top: number | null;
  floor: number | null;
  shock: number;
  /** U and R0. */
  committed: number;
  reserve: number;
  /** K_max with nothing committed (U = 0, Q = R0 ÷ rungs): where the ladder starts. */
  firstRungCap: number | null;
  /** K_max at the look: the highest strike the next ladder put may have; null when none fits. */
  nextPutCap: number | null;
  blockedBecause: LadderPutBlock | null;
}
