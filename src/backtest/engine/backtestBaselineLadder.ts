import type { BacktestBaselineSettings } from "../backtestTypes.js";
import type { SimulatedLedger } from "./ledger/simulatedLedger.js";

// The put ladder on a cash reserve (baseline putsWhenNoCall "reserve_ladder", Marcelo 2026-10-14). The buy-writes' shares
// get ladderSharesPct% of the base (at cost) and the rest is the reserve R0; the base is the larger of the account value
// the cycle started with and today's, so a fall keeps the cycle's plan and a rally grows both with the account. When
// held shares get no call (none qualifies), puts are sold on the reserve, the strike capped by how much of it is
// committed:
//
//   K_max = A − (A − F) × (U + Q) ÷ R0
//     A  = the cycle's break-even per share (the platform's: shares' cost less the cycle's net premium, ÷ shares), or
//          with ladderTop "price" the lower of it and today's price; with ladderPace "one_open", no rung while a ladder
//          put is open
//     F  = the floor: the highest price seen at a look since the cycle started × (1 − S)
//     S  = the stock shock: fixed, or the deepest fall from a running peak in the adjusted closes of the
//          ladderShockLookbackYears before the cycle started, kept within ladderShockMinPct–ladderShockMaxPct; with
//          under a year of closes there (a new listing), ladderShockNoHistoryPct
//     U  = the reserve committed: shares held at cost + open puts' collateral (strike × shares) − the shares' budget,
//          at least 0 (shares called away free it again)
//     Q  = this rung's collateral: min(R0 ÷ ladderRungs, R0 − U)
//
// Example: break-even $100, peak $110, S 70% (F $33), R0 $100,000 in 5 rungs, nothing committed: K_max =
// 100 − 67 × 0.2 = $86.60; with $15,000 committed after an assignment and the break-even down to $95.50:
// 95.50 − 62.50 × 0.35 = $73.63. The last rung's cap is the floor itself.

export interface LadderCycleState {
  /** Null while the symbol is flat. */
  startedOn: string | null;
  /** The account value at the last look the symbol was flat: the cycle's starting value. */
  accountValueAtStart: number;
  peakOnCycleScale: number;
  shock: number;
  /** The ticker's last new rung and the rungs of its session, kept from one cycle to the next (ladderMinutesBetweenRungs, ladderMaxRungsPerSession). */
  lastRungAtMs: number | null;
  rungsInSession: { dateIso: string; count: number } | null;
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
 * it starts one at the first look that finds shares (S fixed then) and raises the peak.
 */
export function noteLadderLook(
  ledger: SimulatedLedger,
  symbol: string,
  look: { cycleOpen: boolean; todayIso: string; accountValue: number; stockPriceOnCycleScale: number; adjustedClosesBefore: readonly { date: string; close: number }[] },
  settings: Pick<BacktestBaselineSettings, "ladderShock" | "ladderShockPct" | "ladderShockMinPct" | "ladderShockMaxPct" | "ladderShockNoHistoryPct" | "ladderShockLookbackYears">,
): LadderCycleState {
  let bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) stateByLedger.set(ledger, (bySymbol = new Map()));
  const kept = bySymbol.get(symbol);
  const pace = { lastRungAtMs: kept?.lastRungAtMs ?? null, rungsInSession: kept?.rungsInSession ?? null };
  let state: LadderCycleState;
  if (!look.cycleOpen) state = { startedOn: null, accountValueAtStart: look.accountValue, peakOnCycleScale: look.stockPriceOnCycleScale, shock: 0, ...pace };
  else if (!kept || kept.startedOn === null)
    state = { startedOn: look.todayIso, accountValueAtStart: kept?.accountValueAtStart ?? look.accountValue, peakOnCycleScale: look.stockPriceOnCycleScale, shock: ladderShock(settings, look.adjustedClosesBefore, look.todayIso), ...pace };
  else state = { ...kept, peakOnCycleScale: Math.max(kept.peakOnCycleScale, look.stockPriceOnCycleScale) };
  bySymbol.set(symbol, state);
  return state;
}

/** Why the ladder may not start a new rung at this look (ladderMinutesBetweenRungs, ladderMaxRungsPerSession), or null when it may. */
export function ladderRungPaceBlock(settings: Pick<BacktestBaselineSettings, "ladderMinutesBetweenRungs" | "ladderMaxRungsPerSession">, state: Pick<LadderCycleState, "lastRungAtMs" | "rungsInSession">, atMs: number, todayIso: string): string | null {
  if (settings.ladderMinutesBetweenRungs > 0 && state.lastRungAtMs !== null) {
    const minutesSince = (atMs - state.lastRungAtMs) / 60_000;
    if (minutesSince < settings.ladderMinutesBetweenRungs) return `no new ladder rung: the last one was ${Math.round(minutesSince)} minutes ago, at most one every ${settings.ladderMinutesBetweenRungs} minutes`;
  }
  const rungsToday = state.rungsInSession?.dateIso === todayIso ? state.rungsInSession.count : 0;
  if (settings.ladderMaxRungsPerSession > 0 && rungsToday >= settings.ladderMaxRungsPerSession) return `no new ladder rung: ${rungsToday} sold this session, at most ${settings.ladderMaxRungsPerSession}`;
  return null;
}

/** Records a new rung (a look that sold at least one ladder put) for the pace rules. */
export function noteLadderRungSold(state: LadderCycleState, atMs: number, todayIso: string): void {
  state.lastRungAtMs = atMs;
  state.rungsInSession = { dateIso: todayIso, count: (state.rungsInSession?.dateIso === todayIso ? state.rungsInSession.count : 0) + 1 };
}

/** The base the budget and the reserve are taken from: the larger of the cycle's starting value and today's account value. */
export function ladderBase(state: Pick<LadderCycleState, "accountValueAtStart">, accountValueToday: number): number {
  return Math.max(state.accountValueAtStart, accountValueToday);
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
export function ladderRungToday(input: { settings: Pick<BacktestBaselineSettings, "ladderSharesPct" | "ladderRungs" | "ladderTop">; state: LadderCycleState; accountValueToday: number; breakEven: number | null; stockPrice: number; heldSharesCost: number; openPutCollateral: number; priceToCycleScale: number }): LadderRung {
  const { settings, state, accountValueToday, breakEven, stockPrice, heldSharesCost, openPutCollateral, priceToCycleScale } = input;
  const top = breakEven === null ? null : settings.ladderTop === "price" ? Math.min(breakEven, stockPrice) : breakEven;
  const base = ladderBase(state, accountValueToday);
  const { sharesBudget, reserve } = ladderBudget(base, settings.ladderSharesPct);
  const committed = ladderCommitted(heldSharesCost, openPutCollateral, sharesBudget);
  const collateral = ladderRungCollateral(reserve, committed, settings.ladderRungs);
  const peak = state.peakOnCycleScale / priceToCycleScale;
  const floor = peak * (1 - state.shock);
  const cap = ladderStrikeCap({ breakEven: top, floor, committed, rungCollateral: collateral, reserve });
  const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
  const note = `break-even ${breakEven === null ? "unknown" : breakEven.toFixed(2)}${settings.ladderTop === "price" && top !== null ? `, top ${top.toFixed(2)}` : ""}, floor ${floor.toFixed(2)} (peak ${peak.toFixed(2)}, shock ${(state.shock * 100).toFixed(0)}%), ${money(committed)} of the ${money(reserve)} reserve committed`;
  return { cap, collateral, note, scores: { ladderCap: cap, ladderTop: top, ladderBase: base, ladderFloor: floor, ladderPeak: peak, ladderShock: state.shock, ladderBreakEven: breakEven, ladderCommitted: committed, ladderReserve: reserve, ladderRungCollateral: collateral } };
}

/** K_max = A − (A − F) × (U + Q) ÷ R0; null when no put fits (no break-even, nothing left, or the break-even at or below the floor). */
export function ladderStrikeCap(input: { breakEven: number | null; floor: number; committed: number; rungCollateral: number; reserve: number }): number | null {
  const { breakEven, floor, committed, rungCollateral, reserve } = input;
  if (breakEven === null || !(reserve > 0) || !(rungCollateral > 0) || breakEven <= floor) return null;
  return breakEven - ((breakEven - floor) * (committed + rungCollateral)) / reserve;
}
