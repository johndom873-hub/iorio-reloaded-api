import type { BacktestVolFarmerSettings, BacktestVolFarmerV2Settings } from "../backtest/backtestTypes.js";
import {
  newVolFarmerV2SymbolState,
  volFarmerV2CallPremiumShare,
  type VolFarmerV2Book,
  type VolFarmerV2CallSale,
  type VolFarmerV2LeapsPurchase,
  type VolFarmerV2LeapsSale,
  type VolFarmerV2LegStatus,
  type VolFarmerV2Position,
  type VolFarmerV2PutSale,
  type VolFarmerV2SymbolState,
} from "../backtest/engine/volFarmerV2Steps.js";
import { formatWholeDollars } from "../lib/formatWholeDollars.js";
import type { PositionFigures } from "../lib/positionSelectors.js";
import type { PlutoSettings } from "./settingsStore.js";

// Vol Farmer v2 on Pluto's live book (Marcelo 2026-10-27): the shared steps (volFarmerV2Steps.ts) run on a book over the
// ticker's positions, and what they decide becomes orders. Pure; volFarmerV2LookLoader.ts reads, volFarmerV2Round.ts sends.
//   memory    the steps' state between looks (pluto_vol_farmer_v2_cycles) and the orders sent but not yet settled. The
//             steps count an order as filled at its planned price when they place it; at a later look, once the order
//             is done, its fills replace the plan: its legs, the contracts that filled and the premium they brought.
//             An order that never filled (blocked, held by a cap, cancelled) is undone as if it was never placed.
//   pot       a new cycle's pot P and the LEAPS cap's base are the ticker's pot in dollars (tickerPotFraction: its
//             allocation × (1 + the excess allowance) × Pluto's capital budget × the account's net liquidation value); the
//             free cash is what Pluto's budget has free (Marcelo 2026-10-27, the allowance 2026-10-28).
//   adoption  a ticker holding shares when v2 first looks at it (Marcelo 2026-10-27): every share is the first
//             position's, its break-even the open cycle's (the Wheel cycles' B-E, its premiums counted there), its open
//             Calls the first position's and its open Puts the second's; a ticker holding only Puts waits for them.
//   fills     orders at the mid (spread share 0); a LEAPS is not held to its ask's size, a partial fill is topped up.

/** The steps' rules from Pluto's live settings (the Vol Farmer's Calls and v2's own, every look). */
export function volFarmerV2RulesOf(settings: PlutoSettings): { farmer: Pick<BacktestVolFarmerSettings, "callMinAbsDelta" | "callMaxAbsDelta" | "maxSpreadPctOfMid">; v2: BacktestVolFarmerV2Settings } {
  return {
    farmer: { callMinAbsDelta: settings.volFarmerV2CallMinAbsDelta, callMaxAbsDelta: settings.volFarmerV2CallMaxAbsDelta, maxSpreadPctOfMid: settings.volFarmerV2MaxSpreadPctOfMid },
    v2: {
      putsStartCallYieldPct: settings.volFarmerV2PutsStartCallYieldPct,
      putMaxAbsDelta: settings.volFarmerV2PutMaxAbsDelta,
      stepBelowFirstBreakEvenPct: settings.volFarmerV2StepBelowFirstBreakEvenPct,
      stepRule: settings.volFarmerV2StepRule,
      leapsMinDte: settings.volFarmerV2LeapsMinDte,
      leapsAbsDelta: settings.volFarmerV2LeapsAbsDelta,
      leapsMaxAccountPct: settings.volFarmerV2LeapsMaxAllocationPct,
      // The LEAPS spread cost is the lab's (2026-10-28): Pluto's orders fill at the market, and its steps price a LEAPS at the mid.
      leapsSpreadCostChargedPct: 0,
      looks: "every_look",
      // The lab's way of sharing its account: live, the round gives each ticker its pot (tickerPotFraction).
      tickerAllocationPct: {},
      excessAllowancePct: settings.excessAllowancePct,
    },
  };
}

export type VolFarmerV2OrderKind = "covered_call" | "cash_secured_put" | "buy_leaps" | "sell_leaps";

/** An order sent and not yet settled: what the steps counted it as when they placed it. */
export interface VolFarmerV2PendingOrder {
  /** The leg reference the state holds until the order settles: "action:<Pluto action id>". */
  ref: string;
  actionId: string;
  kind: VolFarmerV2OrderKind;
  expiry: string;
  strike: number;
  contracts: number;
  /** A Call order that opens a cycle, buying its shares. */
  startsCycle: boolean;
  /** A Call order's contracts per position, and each position's premium the steps added (net of its commission share). */
  contractsByPosition: { first: number; second: number };
  plannedPremiumByPosition: { first: number; second: number };
  /** A LEAPS sale: the LEAPS before it, restored when the sale does not sell it whole. */
  leapsBeforeSale: VolFarmerV2SymbolState["leaps"];
}

export interface VolFarmerV2Memory {
  state: VolFarmerV2SymbolState;
  pending: VolFarmerV2PendingOrder[];
}

/** How a sent order ended (or that it still works), read from its order request and fills. */
export interface VolFarmerV2OrderOutcome {
  /** Still working, or built and not yet confirmed: it stays as planned. */
  working: boolean;
  filledContracts: number;
  /** The option legs its fills went to. */
  optionLegIds: string[];
  /** The option's fills net of commission: received for a sale, paid for a purchase (positive either way). */
  optionNetDollars: number;
  /** A cycle's opening order: the shares bought and what they cost, commission included. */
  sharesBought: number;
  sharesCostDollars: number;
}

/** No fill and no longer working: an order never sent, held, refused or cancelled unfilled. */
export const unfilledVolFarmerV2Outcome: VolFarmerV2OrderOutcome = { working: false, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: 0, sharesCostDollars: 0 };

/**
 * A settled option's premium in place of the one planned for it: its net fill and the shares it covers, under its leg;
 * nothing filled, the premium goes. A position saved before premiums were kept per option (2026-10-28) has the planned
 * premium in its total, which takes the difference instead.
 */
function settleVolFarmerV2Premium(position: VolFarmerV2Position, order: VolFarmerV2PendingOrder, fill: { dollars: number; shares: number; legId: string }, plannedDollars: number): void {
  const index = position.premiums.findIndex((premium) => premium.legId === order.ref);
  if (index >= 0) {
    if (fill.shares === 0) position.premiums.splice(index, 1);
    else position.premiums[index] = { legId: fill.legId, dollars: fill.dollars, shares: fill.shares };
    return;
  }
  const savedTotal = position.premiums.find((premium) => premium.shares === 0);
  if (savedTotal !== undefined) savedTotal.dollars += fill.dollars - plannedDollars;
  else position.premiums.push({ legId: fill.legId, dollars: fill.dollars - plannedDollars, shares: 0 });
}

/** Replaces the plan of a settled order with its fills, in place; a still-working order is left as planned. Answers a note, or null. */
export function settleVolFarmerV2Order(state: VolFarmerV2SymbolState, order: VolFarmerV2PendingOrder, outcome: VolFarmerV2OrderOutcome): string | null {
  if (outcome.working) return null;
  const filled = outcome.filledContracts;
  const shortBy = filled < order.contracts ? `, ${filled} of ${order.contracts} filled` : "";
  if (order.kind === "covered_call") {
    if (order.startsCycle && filled === 0) {
      // The cycle never opened: forget it as the steps had it, keeping the cash check.
      Object.assign(state, { ...newVolFarmerV2SymbolState(), cash: state.cash });
      return `the cycle's opening order did not fill: no cycle`;
    }
    if (order.startsCycle && state.first !== null) {
      state.first.shares = outcome.sharesBought;
      state.first.costPerShare = outcome.sharesBought > 0 ? outcome.sharesCostDollars / outcome.sharesBought : state.first.costPerShare;
    }
    let left = filled;
    for (const name of ["first", "second"] as const) {
      const position = state[name];
      const planned = order.contractsByPosition[name];
      if (position === null || planned === 0) continue;
      const got = Math.min(left, planned);
      left -= got;
      const index = position.calls.findIndex((call) => call.legId === order.ref);
      if (index >= 0) {
        if (got === 0) position.calls.splice(index, 1);
        else position.calls[index] = { legId: outcome.optionLegIds[0] ?? order.ref, shares: got * 100 };
      }
      settleVolFarmerV2Premium(position, order, { dollars: filled === 0 ? 0 : (outcome.optionNetDollars * got) / filled, shares: got * 100, legId: outcome.optionLegIds[0] ?? order.ref }, order.plannedPremiumByPosition[name]);
    }
    return filled === order.contracts ? null : `the Call order on ${order.strike}${shortBy}`;
  }
  if (order.kind === "cash_secured_put") {
    const second = state.second;
    if (second !== null) {
      const index = second.puts.findIndex((put) => put.legId === order.ref);
      if (index >= 0) {
        if (filled === 0) second.puts.splice(index, 1);
        else second.puts[index] = { legId: outcome.optionLegIds[0] ?? order.ref, shares: filled * 100 };
      }
      settleVolFarmerV2Premium(second, order, { dollars: outcome.optionNetDollars, shares: filled * 100, legId: outcome.optionLegIds[0] ?? order.ref }, order.plannedPremiumByPosition.second);
    }
    return filled === order.contracts ? null : `the Put order on ${order.strike}${shortBy}`;
  }
  if (order.kind === "buy_leaps") {
    const leaps = state.leaps;
    if (leaps !== null) {
      leaps.legIds = leaps.legIds.flatMap((legId) => (legId === order.ref ? outcome.optionLegIds : [legId]));
      // Nothing of the LEAPS bought: the steps try again at a later look.
      if (leaps.legIds.length === 0) {
        state.leaps = null;
        state.leapsBought = false;
      }
    }
    return filled === order.contracts ? null : `the LEAPS order${shortBy}${filled < order.contracts && filled > 0 ? ": topped up at the next looks" : ""}`;
  }
  // A LEAPS sale short of the whole: the LEAPS is the steps' again, and what is left is sold at the next look.
  if (filled < order.contracts && order.leapsBeforeSale !== null) {
    state.leaps = order.leapsBeforeSale;
    state.leapsToSell = true;
  }
  return filled === order.contracts ? null : `the LEAPS sale${shortBy}: the rest is sold at the next look`;
}

/** A memory as saved: a position saved before premiums were kept per option (2026-10-28) has its premium total as one, counted in full. */
export function volFarmerV2MemoryFromStored(memory: VolFarmerV2Memory): VolFarmerV2Memory {
  for (const position of [memory.state.first, memory.state.second]) {
    if (position === null || Array.isArray(position.premiums)) continue;
    const saved = position as VolFarmerV2Position & { premiumDollars?: number };
    const savedTotal = saved.premiumDollars ?? 0;
    delete saved.premiumDollars;
    position.premiums = savedTotal === 0 ? [] : [{ legId: "", dollars: savedTotal, shares: 0 }];
  }
  return memory;
}

/** Every leg reference `from` in the state becomes `to` (a planned order's, once it is sent). */
export function replaceVolFarmerV2LegRef(state: VolFarmerV2SymbolState, from: string, to: string): void {
  for (const position of [state.first, state.second]) {
    if (position === null) continue;
    for (const entry of [...position.calls, ...position.puts, ...position.premiums]) if (entry.legId === from) entry.legId = to;
  }
  if (state.leaps !== null) state.leaps.legIds = state.leaps.legIds.map((legId) => (legId === from ? to : legId));
}

/** The first look at a ticker that holds something: its holdings as v2's positions, or why it waits. */
export function adoptVolFarmerV2Holdings(input: { positions: readonly PositionFigures[]; cycleBreakEvenPerShare: number | null; potDollars: number }): { state: VolFarmerV2SymbolState } | { waiting: string } {
  const openLegs = input.positions.filter((position) => position.status === "open").flatMap((position) => position.legs.filter((leg) => leg.exitAt === null));
  const shares = openLegs.filter((leg) => leg.legType === "stock" && leg.side === "long").reduce((sum, leg) => sum + leg.quantity, 0);
  if (shares === 0) return { waiting: "holds no shares yet: its open Puts are left to expire or be assigned before v2 adopts it" };
  if (input.cycleBreakEvenPerShare === null) return { waiting: "holds shares but its cycle's break-even cannot be worked out, so v2 cannot adopt it yet" };
  const shortOptions = (optionType: "call" | "put") => openLegs.filter((leg) => leg.legType === "option" && leg.side === "short" && leg.optionType === optionType).map((leg) => ({ legId: leg.id, shares: leg.quantity * leg.multiplier }));
  const state = newVolFarmerV2SymbolState();
  state.potDollars = input.potDollars;
  // The cycle's break-even already counts every premium of the cycle (its Puts' included): the positions add none.
  state.first = { shares, costPerShare: input.cycleBreakEvenPerShare, premiums: [], calls: shortOptions("call"), puts: [] };
  const puts = shortOptions("put");
  if (puts.length > 0) state.second = { shares: 0, costPerShare: 0, premiums: [], calls: [], puts };
  return { state };
}

/** What the live book reads of the ticker once its pending orders are settled. */
export interface VolFarmerV2LiveSnapshot {
  /** Every leg the memory refers to and the ticker's open option legs, by id. */
  legStatusById: ReadonlyMap<string, VolFarmerV2LegStatus>;
  /** The ticker's open option legs' contracts. */
  openOptionContracts: readonly { expiry: string; strike: number }[];
  /** No shares and no option held on the ticker. */
  flat: boolean;
  /** What Pluto's budget has free for the ticker: its free cash, less what other orders tie up. */
  freeCash: number;
  /** The ticker's pot in dollars (its allocation raised by the excess allowance): a new cycle's pot and the LEAPS cap's base. */
  potDollars: number;
  stockPrice: number;
  optionCommissionDollars(contracts: number): number;
  stockCommissionDollars(shares: number): number;
}

export type VolFarmerV2PlannedOrder =
  | { ref: string; kind: "covered_call"; sale: VolFarmerV2CallSale }
  | { ref: string; kind: "cash_secured_put"; sale: VolFarmerV2PutSale }
  | { ref: string; kind: "buy_leaps"; purchase: VolFarmerV2LeapsPurchase }
  | { ref: string; kind: "sell_leaps"; sale: VolFarmerV2LeapsSale; leapsBeforeSale: VolFarmerV2SymbolState["leaps"] };

/**
 * The book the steps run on at one look: the snapshot, the orders still working (open, as planned) and the orders the
 * look places, each applied at once to the free cash and the contracts held, and collected with a reference of its own.
 * The tickers share Pluto's budget (Marcelo 2026-10-28), so an order the free cash cut is noted: the steps word a new
 * cycle's and a Put's in the look's note, and a LEAPS held below its cap is worded here (`cashCutNotes`).
 */
export function createVolFarmerV2LiveBook(input: { state: VolFarmerV2SymbolState; pending: readonly VolFarmerV2PendingOrder[]; snapshot: VolFarmerV2LiveSnapshot }): { book: VolFarmerV2Book; planned: VolFarmerV2PlannedOrder[]; cashCutNotes: string[] } {
  const { state, pending, snapshot } = input;
  const planned: VolFarmerV2PlannedOrder[] = [];
  const cashCutNotes: string[] = [];
  let freeCash = snapshot.freeCash;
  const openStatus = (strike: number, contracts: number): VolFarmerV2LegStatus => ({ closed: false, assigned: false, strike, contracts });
  const statusOfPlanned = (ref: string): VolFarmerV2LegStatus | undefined => {
    const order = planned.find((entry) => entry.ref === ref);
    if (order === undefined) return undefined;
    if (order.kind === "buy_leaps") return openStatus(order.purchase.strike, order.purchase.contracts);
    if (order.kind === "sell_leaps") return undefined;
    return openStatus(order.sale.candidate.strike, order.sale.contracts);
  };
  const plannedContracts = () =>
    planned.flatMap((order) => (order.kind === "sell_leaps" ? [] : order.kind === "buy_leaps" ? [{ expiry: order.purchase.expiry, strike: order.purchase.strike }] : [{ expiry: order.sale.candidate.expiry, strike: order.sale.candidate.strike }]));
  const nextRef = () => `planned:${planned.length + 1}`;
  const book: VolFarmerV2Book = {
    isFlat: () => snapshot.flat && pending.length === 0 && planned.length === 0,
    freeCash: () => Math.max(0, freeCash),
    potForNewCycle: () => snapshot.potDollars,
    leapsCapBaseDollars: () => snapshot.potDollars,
    openOptionContracts: () => [...snapshot.openOptionContracts, ...pending.filter((order) => order.kind !== "sell_leaps").map((order) => ({ expiry: order.expiry, strike: order.strike })), ...plannedContracts()],
    leg(legId) {
      const working = pending.find((order) => order.ref === legId);
      if (working !== undefined) return openStatus(working.strike, working.contracts);
      return statusOfPlanned(legId) ?? snapshot.legStatusById.get(legId);
    },
    sellCoveredCall(sale) {
      const ref = nextRef();
      planned.push({ ref, kind: "covered_call", sale });
      const shares = sale.contracts * 100;
      freeCash += sale.candidate.fillPrice * shares - snapshot.optionCommissionDollars(sale.contracts) - (sale.startsCycle ? snapshot.stockPrice * shares + snapshot.stockCommissionDollars(shares) : 0);
      return ref;
    },
    sellCashSecuredPut(sale) {
      const ref = nextRef();
      planned.push({ ref, kind: "cash_secured_put", sale });
      freeCash += sale.candidate.fillPrice * 100 * sale.contracts - snapshot.optionCommissionDollars(sale.contracts) - sale.candidate.strike * 100 * sale.contracts;
      return ref;
    },
    buyLeaps(purchase) {
      const ref = nextRef();
      planned.push({ ref, kind: "buy_leaps", purchase });
      freeCash -= purchase.fillPrice * 100 * purchase.contracts + snapshot.optionCommissionDollars(purchase.contracts);
      return ref;
    },
    // A sale's proceeds are not counted until it fills.
    sellLeaps(sale) {
      planned.push({ ref: nextRef(), kind: "sell_leaps", sale, leapsBeforeSale: state.leaps === null ? null : structuredClone(state.leaps) });
    },
    // A LEAPS the free cash pays for no contract of is the steps' "no LEAPS" note.
    noteCashCut(cut) {
      if (cut.order === "leaps" && cut.filledContracts > 0) cashCutNotes.push(`the free cash (${formatWholeDollars(cut.freeCash)}) held the LEAPS to ${cut.filledContracts} of the ${cut.filledContracts + cut.unsoldContracts} contracts its cap allows`);
    },
  };
  return { book, planned, cashCutNotes };
}

/** What a planned order is counted as until it settles, with the action that sent it. */
export function pendingVolFarmerV2Order(state: VolFarmerV2SymbolState, order: VolFarmerV2PlannedOrder, actionId: string, optionCommissionDollars: (contracts: number) => number): VolFarmerV2PendingOrder {
  const ref = `action:${actionId}`;
  const base = { ref, actionId, startsCycle: false, contractsByPosition: { first: 0, second: 0 }, plannedPremiumByPosition: { first: 0, second: 0 }, leapsBeforeSale: null };
  if (order.kind === "covered_call") {
    const { candidate, contracts } = order.sale;
    const contractsOf = (name: "first" | "second") => (state[name]?.calls.find((call) => call.legId === order.ref)?.shares ?? 0) / 100;
    const contractsByPosition = { first: contractsOf("first"), second: contractsOf("second") };
    const commission = optionCommissionDollars(contracts);
    const premiumOf = (positionContracts: number) => (positionContracts === 0 ? 0 : volFarmerV2CallPremiumShare(candidate.fillPrice, positionContracts, contracts, commission));
    return { ...base, kind: "covered_call", expiry: candidate.expiry, strike: candidate.strike, contracts, startsCycle: order.sale.startsCycle, contractsByPosition, plannedPremiumByPosition: { first: premiumOf(contractsByPosition.first), second: premiumOf(contractsByPosition.second) } };
  }
  if (order.kind === "cash_secured_put") {
    const { candidate, contracts } = order.sale;
    return { ...base, kind: "cash_secured_put", expiry: candidate.expiry, strike: candidate.strike, contracts, plannedPremiumByPosition: { first: 0, second: candidate.fillPrice * 100 * contracts - optionCommissionDollars(contracts) } };
  }
  if (order.kind === "buy_leaps") return { ...base, kind: "buy_leaps", expiry: order.purchase.expiry, strike: order.purchase.strike, contracts: order.purchase.contracts };
  return { ...base, kind: "sell_leaps", expiry: order.sale.expiry, strike: order.sale.strike, contracts: order.sale.contracts, leapsBeforeSale: order.leapsBeforeSale };
}
