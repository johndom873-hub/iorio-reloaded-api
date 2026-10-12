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

/** The only way cash changes: the journal entry and the balance together. */
export function recordCash(ledger: SimulatedLedger, entry: CashJournalEntry): void {
  if (entry.amount === 0) return;
  ledger.cashJournal.push(entry);
  ledger.cash += entry.amount;
}

export function nextLedgerId(ledger: SimulatedLedger, kind: "position" | "leg" | "trade"): string {
  const id = `${kind}-${ledger.nextRowNumber}`;
  ledger.nextRowNumber += 1;
  return id;
}

export function requirePosition(ledger: SimulatedLedger, positionId: string): LedgerPosition {
  const position = ledger.positions.find((entry) => entry.id === positionId);
  if (!position) throw new Error(`No position ${positionId} in the ledger.`);
  return position;
}

export function requireLeg(ledger: SimulatedLedger, legId: string): LedgerLeg {
  const leg = ledger.legs.find((entry) => entry.id === legId);
  if (!leg) throw new Error(`No leg ${legId} in the ledger.`);
  return leg;
}

export function legsOfPosition(ledger: SimulatedLedger, positionId: string): LedgerLeg[] {
  return ledger.legs.filter((leg) => leg.positionId === positionId);
}

export function positionsOfSymbol(ledger: SimulatedLedger, symbol: string): LedgerPosition[] {
  return ledger.positions.filter((position) => position.symbol === symbol);
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
