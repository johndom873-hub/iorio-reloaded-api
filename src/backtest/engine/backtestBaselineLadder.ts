import type { BacktestBaselineSettings } from "../backtestTypes.js";
import type { SimulatedLedger } from "./ledger/simulatedLedger.js";

// The put ladder on a cash reserve (baseline putsWhenNoCall "reserve_ladder", Marcelo 2026-10-14). The Covered Call entries' shares
// get ladderSharesPct% of the base (at cost) and the rest is the reserve R0; the base is the larger of the account value
// the cycle started with and today's, so a fall keeps the cycle's plan and a rally grows both with the account. In a
// session of per-ticker pots each ticker's base is its share of that (w = its pot ÷ every pot, fixed for the session;
// approved by Marcelo 2026-10-15), and every ticker shares the one account, its cash and its interest. When
// held shares get no call (none qualifies), puts are sold on the reserve, the strike capped by how much of it is
// committed:
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

export interface LadderCycleState {
  /** Null while the symbol is flat. */
  startedOn: string | null;
  /** The account value at the last look the symbol was flat: the cycle's starting value. */
  accountValueAtStart: number;
  shock: number;
}

export interface LadderBudget {
  sharesBudget: number;
  reserve: number;
}

const stateByLedger = new WeakMap<SimulatedLedger, Map<string, LadderCycleState>>();

/** Deepest fall from a running peak, as a positive fraction (0.66 = −66%); 0 for fewer than two closes. */
export function deepestFallFromPeak(closes: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let deepest = 0;
  for (const close of closes) {
    if (!(close > 0)) continue;
    peak = Math.max(peak, close);
    deepest = Math.max(deepest, 1 - close / peak);
  }
  return deepest;
}

const minimumHistoryCloses = 250;

/** S for a cycle starting on startIso: fixed, or from the closes before it (under a year of them: ladderShockNoHistoryPct). */
export function ladderShock(settings: Pick<BacktestBaselineSettings, "ladderShock" | "ladderShockPct" | "ladderShockMinPct" | "ladderShockMaxPct" | "ladderShockNoHistoryPct" | "ladderShockLookbackYears">, adjustedClosesBefore: readonly { date: string; close: number }[], startIso: string): number {
  if (settings.ladderShock === "fixed") return settings.ladderShockPct / 100;
  const fromIso = `${Number(startIso.slice(0, 4)) - settings.ladderShockLookbackYears}${startIso.slice(4)}`;
  const window = adjustedClosesBefore.filter((bar) => bar.date >= fromIso && bar.date < startIso).map((bar) => bar.close);
  if (window.length < minimumHistoryCloses) return settings.ladderShockNoHistoryPct / 100;
  return Math.min(settings.ladderShockMaxPct / 100, Math.max(settings.ladderShockMinPct / 100, deepestFallFromPeak(window)));
}

/**
 * The symbol's ladder state at a look, updated: flat, it records the account value (the next cycle's start); in a cycle,
 * it starts one at the first look that finds shares (S fixed then).
 */
export function noteLadderLook(
  ledger: SimulatedLedger,
  symbol: string,
  look: { cycleOpen: boolean; todayIso: string; accountValue: number; adjustedClosesBefore: readonly { date: string; close: number }[] },
  settings: Pick<BacktestBaselineSettings, "ladderShock" | "ladderShockPct" | "ladderShockMinPct" | "ladderShockMaxPct" | "ladderShockNoHistoryPct" | "ladderShockLookbackYears">,
): LadderCycleState {
  let bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) stateByLedger.set(ledger, (bySymbol = new Map()));
  const kept = bySymbol.get(symbol);
  let state: LadderCycleState;
  if (!look.cycleOpen) state = { startedOn: null, accountValueAtStart: look.accountValue, shock: 0 };
  else if (!kept || kept.startedOn === null) state = { startedOn: look.todayIso, accountValueAtStart: kept?.accountValueAtStart ?? look.accountValue, shock: ladderShock(settings, look.adjustedClosesBefore, look.todayIso) };
  else state = kept;
  bySymbol.set(symbol, state);
  return state;
}

/** The base the budget and the reserve are taken from: the ticker's weight × the larger of the account value at the cycle's start and today's (weight 1 when the session's tickers share one account). */
export function ladderBase(state: Pick<LadderCycleState, "accountValueAtStart">, accountValueToday: number, tickerWeight: number): number {
  return Math.max(state.accountValueAtStart, accountValueToday) * tickerWeight;
}

export function ladderBudget(base: number, sharesPct: number): LadderBudget {
  return { sharesBudget: (base * sharesPct) / 100, reserve: (base * (100 - sharesPct)) / 100 };
}

/** U: what the stock holds beyond the shares' budget (shares at cost + open puts' collateral), at least 0. */
export function ladderCommitted(heldSharesCost: number, openPutCollateral: number, sharesBudget: number): number {
  return Math.max(0, heldSharesCost + openPutCollateral - sharesBudget);
}

/** Q: the next rung's collateral, at most R0 ÷ rungs and what is left of the reserve. */
export function ladderRungCollateral(reserve: number, committed: number, rungs: number): number {
  return Math.max(0, Math.min(reserve / rungs, reserve - committed));
}

/** Round lots the shares' budget still has room for at today's fill (room = budget − shares at cost − open puts' collateral). */
export function ladderShareLots(roomDollars: number, stockFillPrice: number): number {
  return roomDollars > 0 && stockFillPrice > 0 ? Math.floor(roomDollars / (stockFillPrice * 100)) : 0;
}

export interface LadderRung {
  /** K_max on today's scale; null when no put fits. */
  cap: number | null;
  collateral: number;
  note: string;
  scores: Record<string, number | null>;
}

/** Today's rung: the cap, its collateral and what the action records about it. */
export function ladderRungToday(input: { settings: Pick<BacktestBaselineSettings, "ladderSharesPct" | "ladderRungs" | "ladderTop">; state: LadderCycleState; accountValueToday: number; tickerWeight: number; breakEven: number | null; stockPrice: number; heldSharesCost: number; openPutCollateral: number; sharesAverageCost: number | null }): LadderRung {
  const { settings, state, accountValueToday, tickerWeight, breakEven, stockPrice, heldSharesCost, openPutCollateral, sharesAverageCost } = input;
  const top = breakEven === null ? null : settings.ladderTop === "price" ? Math.min(breakEven, stockPrice) : breakEven;
  const base = ladderBase(state, accountValueToday, tickerWeight);
  const { sharesBudget, reserve } = ladderBudget(base, settings.ladderSharesPct);
  const committed = ladderCommitted(heldSharesCost, openPutCollateral, sharesBudget);
  const collateral = ladderRungCollateral(reserve, committed, settings.ladderRungs);
  const floor = sharesAverageCost === null ? null : sharesAverageCost * (1 - state.shock);
  const cap = floor === null ? null : ladderStrikeCap({ breakEven: top, floor, committed, rungCollateral: collateral, reserve });
  const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
  const note = `break-even ${breakEven === null ? "unknown" : breakEven.toFixed(2)}${settings.ladderTop === "price" && top !== null ? `, top ${top.toFixed(2)}` : ""}, ${floor === null ? "no shares held, no floor" : `floor ${floor.toFixed(2)} (average cost ${sharesAverageCost!.toFixed(2)}, shock ${(state.shock * 100).toFixed(0)}%)`}, ${money(committed)} of the ${money(reserve)} reserve committed`;
  return { cap, collateral, note, scores: { ladderCap: cap, ladderTop: top, ladderBase: base, ladderFloor: floor, ladderAverageCost: sharesAverageCost, ladderShock: state.shock, ladderBreakEven: breakEven, ladderCommitted: committed, ladderReserve: reserve, ladderRungCollateral: collateral } };
}

/** K_max = A − (A − F) × (U + Q) ÷ R0; null when no put fits (no break-even, nothing left, or the break-even at or below the floor). */
export function ladderStrikeCap(input: { breakEven: number | null; floor: number; committed: number; rungCollateral: number; reserve: number }): number | null {
  const { breakEven, floor, committed, rungCollateral, reserve } = input;
  if (breakEven === null || !(reserve > 0) || !(rungCollateral > 0) || breakEven <= floor) return null;
  return breakEven - ((breakEven - floor) * (committed + rungCollateral)) / reserve;
}
