import type { OptionSettlementOutcome } from "../../../lib/cycles.js";
import type { PositionLegFigures } from "../../../lib/positionSelectors.js";

// The simulated book (docs/backtesting/FULL-FIDELITY-DESIGN.md §3): rows shaped like the live tables (positions,
// position_legs, trades, position_share_sources) plus cash and a cash journal, held in memory. Only the event applier
// (ledgerEvents.ts) changes it, and each event leaves the rows the live reconciler leaves for the same event
// (docs/backtesting/INVENTORY-WHEEL-ACCOUNTING.md §1.5), so the live selectors and the cycle engine read it unchanged
// (ledgerSelectors.ts).

export type LedgerStrategyKey = "cash_secured_put" | "covered_call" | "unstructured";
export type LedgerCloseReason = "assigned" | "expired_worthless" | "closed_via_app" | "stock_rolled_into_covered_call";
export type LedgerUnstructuredReason = "csp_assigned_stock" | "cc_expired_leftover_stock" | "unknown";

/** positions. */
export interface LedgerPosition {
  id: string;
  symbol: string;
  strategyKey: LedgerStrategyKey;
  status: "open" | "closed";
  openedAt: Date;
  closedAt: Date | null;
  closeReason: LedgerCloseReason | null;
  unstructuredReason: LedgerUnstructuredReason | null;
}

/**
 * position_legs. Prices follow the live conventions: an option's entry is its fill less the opening commission per
 * share, a stock leg's entry is its cost per share with the commission, an exit is the raw fill (0 at expiry or
 * assignment; the strike for called-away shares; the entry price for shares handed to another position).
 */
export interface LedgerLeg extends PositionLegFigures {
  positionId: string;
  /** The leg a partial sale carved this closed slice from. */
  parentLegId: string | null;
  /** How an option leg settled at expiry; null while open or when it was closed by a trade. */
  settledAs: OptionSettlementOutcome | null;
  /** The underlying's close the settlement was decided on (the cycle engine's expiry-date close). */
  expiryClose: number | null;
}

/** trades. A closing trade carries its commission; an opening one too, though the leg's entry already includes it. */
export interface LedgerTrade {
  id: string;
  legId: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  commission: number;
  executedAt: Date;
  isClosingTrade: boolean;
  /** The simulated Pluto action that caused it; null for a settlement. */
  actionId: string | null;
}

/** position_share_sources: `positionId` received shares from `sourcePositionId`. */
export interface LedgerShareSource {
  positionId: string;
  sourcePositionId: string;
}

/**
 * What moved the cash: `premium` an option sold, `buyback` an option bought back, `commission` on either or on shares,
 * `share_purchase` and `share_sale` stock fills, `assignment` shares put to the book at the strike, `call_away` shares
 * called away at the strike, `interest` on the cash balance, `deposit` the starting cash.
 */
export type CashJournalKind = "deposit" | "interest" | "premium" | "buyback" | "commission" | "share_purchase" | "share_sale" | "assignment" | "call_away";

/** One movement of cash; `amount` is signed (money in is positive). The journal always sums to `cash`. */
export interface CashJournalEntry {
  at: Date;
  kind: CashJournalKind;
  amount: number;
  symbol: string | null;
  positionId: string | null;
  legId: string | null;
}

export interface SimulatedLedger {
  positions: LedgerPosition[];
  legs: LedgerLeg[];
  trades: LedgerTrade[];
  shareSources: LedgerShareSource[];
  cash: number;
  cashJournal: CashJournalEntry[];
  /**
   * The cumulative split factor of the day each symbol's open wheel cycle began (splitFactors.ts): every price and
   * quantity of that cycle is on that day's scale until the symbol is flat again. The engine scales what it passes in;
   * the ledger only remembers the factor.
   */
  cycleSplitFactorBySymbol: Map<string, number>;
  /**
   * A symbol that went flat: when, and the split factor its cycle was on. A position opened on it within the cycle
   * grouping window (in practice at the same instant: a later pass of the same look) continues that cycle on its scale,
   * as the platform's cycle derivation keeps one cycle there; later than that, a new cycle starts on that day's scale.
   */
  endedCycleBySymbol: Map<string, { splitFactor: number; flatSince: Date }>;
  nextRowNumber: number;
}

/** Events this close together on a symbol belong to one wheel cycle: the grouping window of the platform's cycle derivation (lib/cycles.ts). */
export const cycleGroupingWindowMs = 120_000;

export function createSimulatedLedger(startingCash: number, at: Date): SimulatedLedger {
  const ledger: SimulatedLedger = { positions: [], legs: [], trades: [], shareSources: [], cash: 0, cashJournal: [], cycleSplitFactorBySymbol: new Map(), endedCycleBySymbol: new Map(), nextRowNumber: 1 };
  recordCash(ledger, { at, kind: "deposit", amount: startingCash, symbol: null, positionId: null, legId: null });
  return ledger;
}

/**
 * Each ledger's revision: raised whenever the book may change (every ledger event, before and after it, and every
 * cash entry or new row id), so a selector can keep what it read from a revision until the next one. Kept beside the
 * ledger object: a structuredClone of the book starts its own.
 */
const revisionByLedger = new WeakMap<SimulatedLedger, number>();

export function ledgerRevision(ledger: SimulatedLedger): number {
  return revisionByLedger.get(ledger) ?? 0;
}

export function markLedgerChanged(ledger: SimulatedLedger): void {
  revisionByLedger.set(ledger, ledgerRevision(ledger) + 1);
}

/** Applies a change to the book, its revision raised before and after it. */
export function changingLedger<T>(ledger: SimulatedLedger, apply: () => T): T {
  markLedgerChanged(ledger);
  try {
    return apply();
  } finally {
    markLedgerChanged(ledger);
  }
}

/** The only way cash changes: the journal entry and the balance together. */
export function recordCash(ledger: SimulatedLedger, entry: CashJournalEntry): void {
  if (entry.amount === 0) return;
  markLedgerChanged(ledger);
  ledger.cashJournal.push(entry);
  ledger.cash += entry.amount;
}

export function nextLedgerId(ledger: SimulatedLedger, kind: "position" | "leg" | "trade"): string {
  markLedgerChanged(ledger);
  const id = `${kind}-${ledger.nextRowNumber}`;
  ledger.nextRowNumber += 1;
  return id;
}

/**
 * The ledger's rows by id, legs by position and positions by symbol, each list in the ledger's order. Rows are only ever
 * appended (ledgerEvents.ts) and a row's id, position and symbol never change, so the index takes in the rows added
 * since it was last read; a ledger whose arrays were replaced (a test building one by hand) is indexed afresh. Kept per
 * ledger object: a structuredClone of the book gets its own.
 */
interface LedgerRowIndex {
  positions: LedgerPosition[];
  legs: LedgerLeg[];
  indexedPositionCount: number;
  indexedLegCount: number;
  positionById: Map<string, LedgerPosition>;
  legById: Map<string, LedgerLeg>;
  legsByPositionId: Map<string, LedgerLeg[]>;
  positionsBySymbol: Map<string, LedgerPosition[]>;
}

const rowIndexByLedger = new WeakMap<SimulatedLedger, LedgerRowIndex>();

function rowIndexOf(ledger: SimulatedLedger): LedgerRowIndex {
  let index = rowIndexByLedger.get(ledger);
  if (!index || index.positions !== ledger.positions || index.legs !== ledger.legs) {
    index = { positions: ledger.positions, legs: ledger.legs, indexedPositionCount: 0, indexedLegCount: 0, positionById: new Map(), legById: new Map(), legsByPositionId: new Map(), positionsBySymbol: new Map() };
    rowIndexByLedger.set(ledger, index);
  }
  for (; index.indexedPositionCount < ledger.positions.length; index.indexedPositionCount++) {
    const position = ledger.positions[index.indexedPositionCount]!;
    if (!index.positionById.has(position.id)) index.positionById.set(position.id, position);
    const ofSymbol = index.positionsBySymbol.get(position.symbol);
    if (ofSymbol) ofSymbol.push(position);
    else index.positionsBySymbol.set(position.symbol, [position]);
  }
  for (; index.indexedLegCount < ledger.legs.length; index.indexedLegCount++) {
    const leg = ledger.legs[index.indexedLegCount]!;
    if (!index.legById.has(leg.id)) index.legById.set(leg.id, leg);
    const ofPosition = index.legsByPositionId.get(leg.positionId);
    if (ofPosition) ofPosition.push(leg);
    else index.legsByPositionId.set(leg.positionId, [leg]);
  }
  return index;
}

export function requirePosition(ledger: SimulatedLedger, positionId: string): LedgerPosition {
  const position = rowIndexOf(ledger).positionById.get(positionId);
  if (!position) throw new Error(`No position ${positionId} in the ledger.`);
  return position;
}

/** The position with this id; undefined when the ledger has none. */
export function findPosition(ledger: SimulatedLedger, positionId: string): LedgerPosition | undefined {
  return rowIndexOf(ledger).positionById.get(positionId);
}

/** The leg with this id; undefined when the ledger has none. */
export function findLeg(ledger: SimulatedLedger, legId: string): LedgerLeg | undefined {
  return rowIndexOf(ledger).legById.get(legId);
}

export function requireLeg(ledger: SimulatedLedger, legId: string): LedgerLeg {
  const leg = rowIndexOf(ledger).legById.get(legId);
  if (!leg) throw new Error(`No leg ${legId} in the ledger.`);
  return leg;
}

export function legsOfPosition(ledger: SimulatedLedger, positionId: string): LedgerLeg[] {
  return [...(rowIndexOf(ledger).legsByPositionId.get(positionId) ?? [])];
}

export function positionsOfSymbol(ledger: SimulatedLedger, symbol: string): LedgerPosition[] {
  return [...(rowIndexOf(ledger).positionsBySymbol.get(symbol) ?? [])];
}

/** Flat: no open position on the symbol (no shares, no open option leg), which is when a wheel cycle ends. */
export function isSymbolFlat(ledger: SimulatedLedger, symbol: string): boolean {
  return !ledger.positions.some((position) => position.symbol === symbol && position.status === "open");
}

/**
 * The split factor the symbol's prices, strikes and share counts are on: its open cycle's; else, at an instant within
 * the grouping window of the moment it went flat, the factor of the cycle that just closed (a position opened now
 * continues it); else today's own (the next cycle starts on it). The engine puts a price traded today on that scale with
 * × this ÷ F(today), and a share count with × F(today) ÷ this, before any event sees it.
 */
export function cycleSplitFactorFor(ledger: SimulatedLedger, symbol: string, splitFactorToday: number, at: Date | null = null): number {
  const openCycleFactor = ledger.cycleSplitFactorBySymbol.get(symbol);
  if (openCycleFactor !== undefined) return openCycleFactor;
  const ended = ledger.endedCycleBySymbol.get(symbol);
  return ended && at !== null && at.getTime() - ended.flatSince.getTime() <= cycleGroupingWindowMs ? ended.splitFactor : splitFactorToday;
}
