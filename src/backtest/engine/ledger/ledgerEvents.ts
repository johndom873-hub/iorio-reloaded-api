import { easternInstant } from "../../../lib/easternIsoDate.js";
import { optionExpiryCloseHourEastern } from "../../../lib/optionExpiryClock.js";
import { sharesPerContract as standardSharesPerContract } from "../backtestBook.js";
import { optionCommissionDollars, stockCommissionDollars } from "./ledgerFills.js";
import {
  cycleSplitFactorFor,
  isSymbolFlat,
  legsOfPosition,
  nextLedgerId,
  positionsOfSymbol,
  recordCash,
  requireLeg,
  requirePosition,
  type CashJournalKind,
  type LedgerCloseReason,
  type LedgerLeg,
  type LedgerPosition,
  type LedgerStrategyKey,
  type LedgerUnstructuredReason,
  type SimulatedLedger,
} from "./simulatedLedger.js";

// The event applier of the simulated book: one function per event, each leaving the rows the live reconciler leaves
// (docs/backtesting/INVENTORY-WHEEL-ACCOUNTING.md §1.5) under the live price conventions (§1.2). Everything one event
// writes carries one timestamp, so the cycle engine's 120-second grouping reads it as one step: a fill's is the
// decision instant, a settlement's 16:00 Eastern of the expiry date.
//
//   option entry price = fill − commission per contract ÷ shares per contract        (a short's credit, net)
//   option exit price  = the buyback fill, its commission on the closing trade; 0 at expiry or assignment, no trade
//   stock entry price  = (Σ shares bought × fill + their commission + Σ shares handed over × their entry) ÷ shares
//   stock exit price   = the sale fill, its commission on the closing trade; the strike when called away, with no
//                        trade; the entry price when the shares are handed to another position
//   assignment         = in the money by $0.01 or more at the expiry close; anything less is worthless
//   shares put to the book enter at the strike, with a stock purchase at the strike and no commission
// One position per option contract; a covered call holds exactly the shares its contracts cover; every uncovered share
// of a symbol sits in one unstructured position, whose stock leg grows at the weighted average when more arrive.
// Prices, strikes and share counts arrive on the split scale of the symbol's open cycle (cycleSplitFactorFor); the
// engine does the scaling. `sharesPerContract` is 100 unless a split since the cycle began changed what one contract
// covers on that scale.

/** In the money by at least this at the expiry close: assigned. */
export const assignmentThresholdDollars = 0.01;
const priceComparisonTolerance = 1e-9;

export type SettlementOutcome = "put_worthless" | "put_assigned" | "call_worthless" | "call_away";

/** 16:00 Eastern of the expiry date: when every settlement is stamped. */
export function expirySettlementInstant(expiryDate: string): Date {
  return easternInstant(expiryDate, optionExpiryCloseHourEastern, 0);
}

function createPosition(ledger: SimulatedLedger, symbol: string, strategyKey: LedgerStrategyKey, at: Date, unstructuredReason: LedgerUnstructuredReason | null = null): LedgerPosition {
  const position: LedgerPosition = { id: nextLedgerId(ledger, "position"), symbol, strategyKey, status: "open", openedAt: at, closedAt: null, closeReason: null, unstructuredReason };
  ledger.positions.push(position);
  return position;
}

function closePosition(position: LedgerPosition, at: Date, closeReason: LedgerCloseReason): void {
  position.status = "closed";
  position.closedAt = at;
  position.closeReason = closeReason;
}

function recordShareSource(ledger: SimulatedLedger, positionId: string, sourcePositionId: string): void {
  if (positionId === sourcePositionId) return;
  if (ledger.shareSources.some((source) => source.positionId === positionId && source.sourcePositionId === sourcePositionId)) return;
  ledger.shareSources.push({ positionId, sourcePositionId });
}

function recordLegCash(ledger: SimulatedLedger, position: LedgerPosition, leg: LedgerLeg, at: Date, kind: CashJournalKind, amount: number): void {
  recordCash(ledger, { at, kind, amount, symbol: position.symbol, positionId: position.id, legId: leg.id });
}

function recordTrade(ledger: SimulatedLedger, leg: LedgerLeg, trade: { side: "buy" | "sell"; quantity: number; price: number; commission: number; at: Date; isClosingTrade: boolean; actionId: string | null }): void {
  ledger.trades.push({ id: nextLedgerId(ledger, "trade"), legId: leg.id, side: trade.side, quantity: trade.quantity, price: trade.price, commission: trade.commission, executedAt: trade.at, isClosingTrade: trade.isClosingTrade, actionId: trade.actionId });
}

/** A position opened on a flat symbol starts a cycle on today's scale, or continues the one that closed within the grouping window. */
function startCycleIfFlat(ledger: SimulatedLedger, symbol: string, splitFactorToday: number, at: Date): void {
  if (!isSymbolFlat(ledger, symbol)) return;
  ledger.cycleSplitFactorBySymbol.set(symbol, cycleSplitFactorFor(ledger, symbol, splitFactorToday, at));
  ledger.endedCycleBySymbol.delete(symbol);
}

function endCycleIfFlat(ledger: SimulatedLedger, symbol: string, at: Date): void {
  if (!isSymbolFlat(ledger, symbol)) return;
  const splitFactor = ledger.cycleSplitFactorBySymbol.get(symbol);
  if (splitFactor === undefined) return;
  ledger.cycleSplitFactorBySymbol.delete(symbol);
  ledger.endedCycleBySymbol.set(symbol, { splitFactor, flatSince: at });
}

function requirePositiveWholeNumber(value: number, what: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${what} must be a positive whole number, got ${value}.`);
}

/** One position per symbol, expiry and strike, puts and calls alike: a second sale would merge into the held one, which Pluto's gates never allow. */
function requireContractNotHeld(ledger: SimulatedLedger, symbol: string, expiryDate: string, strike: number): void {
  const heldPositionIds = new Set(positionsOfSymbol(ledger, symbol).map((position) => position.id));
  const held = ledger.legs.find((leg) => heldPositionIds.has(leg.positionId) && leg.legType === "option" && leg.exitAt === null && leg.expiryDate === expiryDate && leg.strikePrice !== null && Math.abs(leg.strikePrice - strike) < 0.0001);
  if (held) throw new Error(`${symbol} already holds an open option at $${strike} expiring ${expiryDate} (leg ${held.id}): one position per contract.`);
}

/** A short option sold to open: the leg at its fill net of the commission, the opening trade, the premium in and the commission out. */
function sellOptionToOpen(
  ledger: SimulatedLedger,
  position: LedgerPosition,
  option: { optionType: "call" | "put"; strike: number; expiryDate: string; contracts: number; sharesPerContract: number; fillPrice: number; at: Date; actionId: string | null },
): LedgerLeg {
  const commission = optionCommissionDollars(option.contracts);
  const leg: LedgerLeg = {
    id: nextLedgerId(ledger, "leg"),
    positionId: position.id,
    parentLegId: null,
    legType: "option",
    side: "short",
    quantity: option.contracts,
    optionType: option.optionType,
    strikePrice: option.strike,
    expiryDate: option.expiryDate,
    multiplier: option.sharesPerContract,
    entryPrice: option.fillPrice - commission / (option.contracts * option.sharesPerContract),
    entryAt: option.at,
    exitPrice: null,
    exitAt: null,
    settledAs: null,
    expiryClose: null,
  };
  ledger.legs.push(leg);
  recordTrade(ledger, leg, { side: "sell", quantity: option.contracts, price: option.fillPrice, commission, at: option.at, isClosingTrade: false, actionId: option.actionId });
  recordLegCash(ledger, position, leg, option.at, "premium", option.fillPrice * option.sharesPerContract * option.contracts);
  recordLegCash(ledger, position, leg, option.at, "commission", -commission);
  return leg;
}

/** A short option bought back: the leg exits at the fill, the commission sits on the closing trade. */
function buyOptionToClose(ledger: SimulatedLedger, position: LedgerPosition, leg: LedgerLeg, fillPrice: number, at: Date, actionId: string | null): void {
  const commission = optionCommissionDollars(leg.quantity);
  leg.exitPrice = fillPrice;
  leg.exitAt = at;
  recordTrade(ledger, leg, { side: "buy", quantity: leg.quantity, price: fillPrice, commission, at, isClosingTrade: true, actionId });
  recordLegCash(ledger, position, leg, at, "buyback", -fillPrice * leg.multiplier * leg.quantity);
  recordLegCash(ledger, position, leg, at, "commission", -commission);
}

function addStockLeg(ledger: SimulatedLedger, position: LedgerPosition, shares: number, entryPrice: number, at: Date): LedgerLeg {
  const leg: LedgerLeg = {
    id: nextLedgerId(ledger, "leg"),
    positionId: position.id,
    parentLegId: null,
    legType: "stock",
    side: "long",
    quantity: shares,
    optionType: null,
    strikePrice: null,
    expiryDate: null,
    multiplier: 1,
    entryPrice,
    entryAt: at,
    exitPrice: null,
    exitAt: null,
    settledAs: null,
    expiryClose: null,
  };
  ledger.legs.push(leg);
  return leg;
}

/** Shares moving to another position: the leg closes at its own entry price (no P&L) and the successor re-creates it at that price. */
function handOffStockLeg(leg: LedgerLeg, at: Date): void {
  leg.exitPrice = leg.entryPrice;
  leg.exitAt = at;
}

function openLegsOfPosition(ledger: SimulatedLedger, position: LedgerPosition): { optionLeg: LedgerLeg | null; stockLeg: LedgerLeg | null } {
  const openLegs = legsOfPosition(ledger, position.id).filter((leg) => leg.exitAt === null);
  return { optionLeg: openLegs.find((leg) => leg.legType === "option") ?? null, stockLeg: openLegs.find((leg) => leg.legType === "stock") ?? null };
}

/** The symbol's uncovered shares: the open stock legs of its open unstructured positions (one, as the events keep it). */
function openUncoveredStockLegs(ledger: SimulatedLedger, symbol: string): { position: LedgerPosition; leg: LedgerLeg }[] {
  const found: { position: LedgerPosition; leg: LedgerLeg }[] = [];
  for (const position of positionsOfSymbol(ledger, symbol)) {
    if (position.status !== "open" || position.strategyKey !== "unstructured") continue;
    for (const leg of legsOfPosition(ledger, position.id)) if (leg.legType === "stock" && leg.side === "long" && leg.exitAt === null) found.push({ position, leg });
  }
  return found;
}

/**
 * Uncovered shares arriving (an assigned put's, an expired call's, what a new call left uncovered): added to the symbol's
 * open unstructured position at the weighted average, or a new one. The position records where they came from.
 */
function receiveUncoveredShares(ledger: SimulatedLedger, symbol: string, shares: number, entryPrice: number, at: Date, reason: LedgerUnstructuredReason, sourcePositionIds: readonly string[]): { position: LedgerPosition; leg: LedgerLeg } {
  const existing = openUncoveredStockLegs(ledger, symbol)[0];
  let holder: { position: LedgerPosition; leg: LedgerLeg };
  if (existing) {
    existing.leg.entryPrice = (existing.leg.quantity * existing.leg.entryPrice + shares * entryPrice) / (existing.leg.quantity + shares);
    existing.leg.quantity += shares;
    if (existing.position.unstructuredReason === "unknown" && reason !== "unknown") existing.position.unstructuredReason = reason;
    holder = existing;
  } else {
    const position = createPosition(ledger, symbol, "unstructured", at, reason);
    holder = { position, leg: addStockLeg(ledger, position, shares, entryPrice, at) };
  }
  for (const sourcePositionId of sourcePositionIds) recordShareSource(ledger, holder.position.id, sourcePositionId);
  return holder;
}

export interface OpenCashSecuredPutEvent {
  symbol: string;
  /** YYYY-MM-DD. */
  expiryDate: string;
  strike: number;
  contracts: number;
  /** Sale fill per share. */
  fillPrice: number;
  at: Date;
  actionId: string | null;
  /** Today's cumulative split factor: the cycle's, when this sale opens one. */
  splitFactorToday: number;
  /** Shares one contract covers on the cycle's scale: 100 unless a split since the cycle began changed it. */
  sharesPerContract?: number;
}

/** A put sold: a new cash-secured-put position with one short put leg and its opening trade. */
export function openCashSecuredPut(ledger: SimulatedLedger, event: OpenCashSecuredPutEvent): { positionId: string; legId: string } {
  requirePositiveWholeNumber(event.contracts, "Contracts");
  requireContractNotHeld(ledger, event.symbol, event.expiryDate, event.strike);
  startCycleIfFlat(ledger, event.symbol, event.splitFactorToday, event.at);
  const position = createPosition(ledger, event.symbol, "cash_secured_put", event.at);
  const leg = sellOptionToOpen(ledger, position, { optionType: "put", strike: event.strike, expiryDate: event.expiryDate, contracts: event.contracts, sharesPerContract: event.sharesPerContract ?? standardSharesPerContract, fillPrice: event.fillPrice, at: event.at, actionId: event.actionId });
  return { positionId: position.id, legId: leg.id };
}

export interface OpenCoveredCallEvent {
  symbol: string;
  /** YYYY-MM-DD. */
  expiryDate: string;
  strike: number;
  contracts: number;
  /** Sale fill per share of the call. */
  callFillPrice: number;
  /** Purchase fill per share for the shares the symbol's uncovered ones do not supply (unused when they supply them all); null when the order buys none. */
  stockFillPrice: number | null;
  at: Date;
  actionId: string | null;
  /** Today's cumulative split factor: the cycle's, when this order opens one. */
  splitFactorToday: number;
  /** Shares one contract covers on the cycle's scale: 100 unless a split since the cycle began changed it. */
  sharesPerContract?: number;
  /** Shares as traded today per share on the cycle's scale (the stock commission is charged on shares as traded); 1 when omitted. */
  tradedSharesPerLedgerShare?: number;
}

export interface OpenCoveredCallResult {
  positionId: string;
  callLegId: string;
  stockLegId: string;
  sharesBought: number;
  sharesFromHeld: number;
  /** The unstructured position that keeps the uncovered shares the call did not need; null when none are left. */
  leftoverPositionId: string | null;
}

/**
 * A call sold against shares: the symbol's uncovered shares first, the rest bought (a buy-write when it holds none). The
 * new covered-call position holds the call and exactly the shares it covers. An unstructured position that supplied
 * shares closes (stock rolled into covered call), its leg handed off at entry; what the call did not need goes to a new
 * unstructured position.
 */
export function openCoveredCall(ledger: SimulatedLedger, event: OpenCoveredCallEvent): OpenCoveredCallResult {
  requirePositiveWholeNumber(event.contracts, "Contracts");
  requireContractNotHeld(ledger, event.symbol, event.expiryDate, event.strike);
  const sharesPerContract = event.sharesPerContract ?? standardSharesPerContract;
  const sharesNeeded = event.contracts * sharesPerContract;
  const uncovered = openUncoveredStockLegs(ledger, event.symbol);
  const uncoveredShares = uncovered.reduce((sum, held) => sum + held.leg.quantity, 0);
  const sharesFromHeld = Math.min(uncoveredShares, sharesNeeded);
  const sharesBought = sharesNeeded - sharesFromHeld;
  if (sharesBought > 0 && event.stockFillPrice === null) throw new Error(`${event.symbol}: the call needs ${sharesBought} more shares than the ${uncoveredShares} uncovered ones, and no stock fill price was given.`);
  startCycleIfFlat(ledger, event.symbol, event.splitFactorToday, event.at);

  const position = createPosition(ledger, event.symbol, "covered_call", event.at);
  const handedOverEntryPrice = uncoveredShares > 0 ? uncovered.reduce((sum, held) => sum + held.leg.quantity * held.leg.entryPrice, 0) / uncoveredShares : 0;
  for (const held of uncovered) {
    handOffStockLeg(held.leg, event.at);
    closePosition(held.position, event.at, "stock_rolled_into_covered_call");
    recordShareSource(ledger, position.id, held.position.id);
  }

  const stockCommission = stockCommissionDollars(sharesBought * (event.tradedSharesPerLedgerShare ?? 1));
  const purchaseCost = sharesBought > 0 ? sharesBought * event.stockFillPrice! + stockCommission : 0;
  const stockLeg = addStockLeg(ledger, position, sharesNeeded, (sharesFromHeld * handedOverEntryPrice + purchaseCost) / sharesNeeded, event.at);
  if (sharesBought > 0) {
    recordTrade(ledger, stockLeg, { side: "buy", quantity: sharesBought, price: event.stockFillPrice!, commission: stockCommission, at: event.at, isClosingTrade: false, actionId: event.actionId });
    recordLegCash(ledger, position, stockLeg, event.at, "share_purchase", -sharesBought * event.stockFillPrice!);
    recordLegCash(ledger, position, stockLeg, event.at, "commission", -stockCommission);
  }
  const callLeg = sellOptionToOpen(ledger, position, { optionType: "call", strike: event.strike, expiryDate: event.expiryDate, contracts: event.contracts, sharesPerContract, fillPrice: event.callFillPrice, at: event.at, actionId: event.actionId });

  const leftoverShares = uncoveredShares - sharesFromHeld;
  const leftover = leftoverShares > 0 ? receiveUncoveredShares(ledger, event.symbol, leftoverShares, handedOverEntryPrice, event.at, "unknown", uncovered.map((held) => held.position.id)) : null;
  return { positionId: position.id, callLegId: callLeg.id, stockLegId: stockLeg.id, sharesBought, sharesFromHeld, leftoverPositionId: leftover?.position.id ?? null };
}

export interface RollLegEvent {
  /** The open short option leg rolled away from. */
  legId: string;
  /** YYYY-MM-DD. */
  newExpiryDate: string;
  newStrike: number;
  /** Purchase fill per share of the leg bought back. */
  buybackFillPrice: number;
  /** Sale fill per share of the new contract. */
  newFillPrice: number;
  at: Date;
  actionId: string | null;
}

/**
 * A roll: the held leg bought back and the same quantity of a new contract sold, at one instant. The old position
 * closes (closed via app) and the new contract is a new position; a covered call's shares are handed to it at entry.
 */
export function rollLeg(ledger: SimulatedLedger, event: RollLegEvent): { closedPositionId: string; positionId: string; legId: string; stockLegId: string | null } {
  const oldLeg = requireLeg(ledger, event.legId);
  const oldPosition = requirePosition(ledger, oldLeg.positionId);
  if (oldLeg.legType !== "option" || oldLeg.side !== "short" || oldLeg.optionType === null || oldLeg.exitAt !== null) throw new Error(`Leg ${oldLeg.id} is not an open short option: nothing to roll.`);
  const oldStockLeg = openLegsOfPosition(ledger, oldPosition).stockLeg;
  if (oldPosition.strategyKey === "covered_call" && oldStockLeg === null) throw new Error(`Covered call ${oldPosition.id} holds no shares to carry into the roll.`);
  requireContractNotHeld(ledger, oldPosition.symbol, event.newExpiryDate, event.newStrike);

  buyOptionToClose(ledger, oldPosition, oldLeg, event.buybackFillPrice, event.at, event.actionId);
  const newPosition = createPosition(ledger, oldPosition.symbol, oldPosition.strategyKey, event.at);
  let newStockLeg: LedgerLeg | null = null;
  if (oldStockLeg !== null) {
    handOffStockLeg(oldStockLeg, event.at);
    newStockLeg = addStockLeg(ledger, newPosition, oldStockLeg.quantity, oldStockLeg.entryPrice, event.at);
    recordShareSource(ledger, newPosition.id, oldPosition.id);
  }
  closePosition(oldPosition, event.at, "closed_via_app");
  const newLeg = sellOptionToOpen(ledger, newPosition, { optionType: oldLeg.optionType, strike: event.newStrike, expiryDate: event.newExpiryDate, contracts: oldLeg.quantity, sharesPerContract: oldLeg.multiplier, fillPrice: event.newFillPrice, at: event.at, actionId: event.actionId });
  return { closedPositionId: oldPosition.id, positionId: newPosition.id, legId: newLeg.id, stockLegId: newStockLeg?.id ?? null };
}

export interface BuyBackPutEvent {
  /** The open short put leg. */
  legId: string;
  /** Purchase fill per share. */
  fillPrice: number;
  at: Date;
  actionId: string | null;
}

/** A cash-secured put bought back: the leg exits at the fill and its position closes (closed via app). */
export function buyBackPut(ledger: SimulatedLedger, event: BuyBackPutEvent): void {
  const leg = requireLeg(ledger, event.legId);
  const position = requirePosition(ledger, leg.positionId);
  if (leg.legType !== "option" || leg.side !== "short" || leg.optionType !== "put" || leg.exitAt !== null) throw new Error(`Leg ${leg.id} is not an open short put: only a put is bought back on its own.`);
  buyOptionToClose(ledger, position, leg, event.fillPrice, event.at, event.actionId);
  closePosition(position, event.at, "closed_via_app");
  endCycleIfFlat(ledger, position.symbol, event.at);
}

export interface CloseCoveredCallEvent {
  positionId: string;
  /** Purchase fill per share of the call bought back. */
  callFillPrice: number;
  /** Sale fill per share of the shares. */
  stockFillPrice: number;
  at: Date;
  actionId: string | null;
  /** Shares as traded today per share on the cycle's scale (the stock commission is charged on shares as traded); 1 when omitted. */
  tradedSharesPerLedgerShare?: number;
}

/** A whole covered call closed: the call bought back and its shares sold, both legs exiting at their fills. */
export function closeCoveredCall(ledger: SimulatedLedger, event: CloseCoveredCallEvent): void {
  const position = requirePosition(ledger, event.positionId);
  const { optionLeg, stockLeg } = openLegsOfPosition(ledger, position);
  if (position.status !== "open" || position.strategyKey !== "covered_call" || optionLeg === null || stockLeg === null) throw new Error(`Position ${position.id} is not an open covered call with its call and its shares.`);
  buyOptionToClose(ledger, position, optionLeg, event.callFillPrice, event.at, event.actionId);
  sellStockLegShares(ledger, position, stockLeg, stockLeg.quantity, event.stockFillPrice, event.at, event.actionId, event.tradedSharesPerLedgerShare ?? 1);
  closePosition(position, event.at, "closed_via_app");
  endCycleIfFlat(ledger, position.symbol, event.at);
}

/** Shares sold from a stock leg: all of them close the leg at the fill; fewer are carved into their own closed leg, which takes the closing trade. */
function sellStockLegShares(ledger: SimulatedLedger, position: LedgerPosition, stockLeg: LedgerLeg, shares: number, fillPrice: number, at: Date, actionId: string | null, tradedSharesPerLedgerShare: number): LedgerLeg {
  // The book never sells a share it does not hold.
  if (stockLeg.exitAt !== null || shares > stockLeg.quantity) throw new Error(`Position ${position.id} holds ${stockLeg.exitAt !== null ? 0 : stockLeg.quantity} shares on leg ${stockLeg.id}; cannot sell ${shares}.`);
  let soldLeg = stockLeg;
  if (shares < stockLeg.quantity) {
    soldLeg = { ...stockLeg, id: nextLedgerId(ledger, "leg"), parentLegId: stockLeg.id, quantity: shares };
    ledger.legs.push(soldLeg);
    stockLeg.quantity -= shares;
  }
  const commission = stockCommissionDollars(shares * tradedSharesPerLedgerShare);
  soldLeg.exitPrice = fillPrice;
  soldLeg.exitAt = at;
  recordTrade(ledger, soldLeg, { side: "sell", quantity: shares, price: fillPrice, commission, at, isClosingTrade: true, actionId });
  recordLegCash(ledger, position, soldLeg, at, "share_sale", shares * fillPrice);
  recordLegCash(ledger, position, soldLeg, at, "commission", -commission);
  return soldLeg;
}

export interface SellSharesEvent {
  /** The open unstructured position holding the shares. */
  positionId: string;
  shares: number;
  /** Sale fill per share. */
  fillPrice: number;
  at: Date;
  actionId: string | null;
  /** Shares as traded today per share on the cycle's scale (the stock commission is charged on shares as traded); 1 when omitted. */
  tradedSharesPerLedgerShare?: number;
}

/**
 * Uncovered shares sold. All of them: the stock leg exits at the fill and the position closes (closed via app). Some:
 * the sold shares become their own closed leg (parentLegId) carrying the closing trade, and the rest stay open.
 */
export function sellShares(ledger: SimulatedLedger, event: SellSharesEvent): { soldLegId: string; positionClosed: boolean } {
  requirePositiveWholeNumber(event.shares, "Shares");
  const position = requirePosition(ledger, event.positionId);
  const { stockLeg } = openLegsOfPosition(ledger, position);
  if (position.status !== "open" || position.strategyKey !== "unstructured" || stockLeg === null) throw new Error(`Position ${position.id} is not an open unstructured position holding shares.`);
  if (event.shares > stockLeg.quantity) throw new Error(`Position ${position.id} holds ${stockLeg.quantity} shares; cannot sell ${event.shares}.`);
  const positionClosed = event.shares === stockLeg.quantity;
  const soldLeg = sellStockLegShares(ledger, position, stockLeg, event.shares, event.fillPrice, event.at, event.actionId, event.tradedSharesPerLedgerShare ?? 1);
  if (positionClosed) closePosition(position, event.at, "closed_via_app");
  endCycleIfFlat(ledger, position.symbol, event.at);
  return { soldLegId: soldLeg.id, positionClosed };
}

export interface SettleExpiryEvent {
  /** The open short option leg whose expiry date has closed. */
  legId: string;
  /** The underlying's close on the expiry date, on the scale of the leg's cycle. */
  expiryClose: number;
}

/** Whether a short option finishing at `expiryClose` is assigned: in the money by the threshold or more. */
export function isAssignedAtExpiry(optionType: "call" | "put", strike: number, expiryClose: number): boolean {
  const inTheMoneyBy = optionType === "call" ? expiryClose - strike : strike - expiryClose;
  return inTheMoneyBy >= assignmentThresholdDollars - priceComparisonTolerance;
}

/**
 * An option's expiry, stamped 16:00 Eastern of its expiry date. The leg exits at 0 with no trade either way.
 *   put worthless  : the position closes expired worthless
 *   put assigned   : the position closes assigned; the shares enter the symbol's unstructured position at the strike,
 *                    with the stock purchase at the strike (no commission) and the put position as their source
 *   call worthless : the shares are handed at entry to the symbol's unstructured position; the covered call closes
 *                    expired worthless
 *   call-away      : the stock leg exits at the strike with no stock trade; the covered call closes assigned
 */
export function settleExpiry(ledger: SimulatedLedger, event: SettleExpiryEvent): SettlementOutcome {
  const leg = requireLeg(ledger, event.legId);
  const position = requirePosition(ledger, leg.positionId);
  if (leg.legType !== "option" || leg.side !== "short" || leg.optionType === null || leg.strikePrice === null || leg.expiryDate === null || leg.exitAt !== null) throw new Error(`Leg ${leg.id} is not an open short option: nothing to settle.`);
  const at = expirySettlementInstant(leg.expiryDate);
  const assigned = isAssignedAtExpiry(leg.optionType, leg.strikePrice, event.expiryClose);
  const shares = leg.quantity * leg.multiplier;
  leg.exitPrice = 0;
  leg.exitAt = at;
  leg.settledAs = assigned ? "assigned" : "worthless";
  leg.expiryClose = event.expiryClose;

  let outcome: SettlementOutcome;
  if (leg.optionType === "put") {
    closePosition(position, at, assigned ? "assigned" : "expired_worthless");
    if (assigned) {
      const holder = receiveUncoveredShares(ledger, position.symbol, shares, leg.strikePrice, at, "csp_assigned_stock", [position.id]);
      recordTrade(ledger, holder.leg, { side: "buy", quantity: shares, price: leg.strikePrice, commission: 0, at, isClosingTrade: false, actionId: null });
      recordLegCash(ledger, holder.position, holder.leg, at, "assignment", -shares * leg.strikePrice);
    }
    outcome = assigned ? "put_assigned" : "put_worthless";
  } else {
    const { stockLeg } = openLegsOfPosition(ledger, position);
    if (stockLeg === null) throw new Error(`Covered call ${position.id} holds no shares to settle its call against.`);
    if (assigned) {
      // The call takes away exactly the shares it covers.
      if (stockLeg.quantity !== shares) throw new Error(`Covered call ${position.id} is assigned on ${shares} shares but holds ${stockLeg.quantity}.`);
      stockLeg.exitPrice = leg.strikePrice;
      stockLeg.exitAt = at;
      recordLegCash(ledger, position, stockLeg, at, "call_away", shares * leg.strikePrice);
      closePosition(position, at, "assigned");
    } else {
      handOffStockLeg(stockLeg, at);
      closePosition(position, at, "expired_worthless");
      receiveUncoveredShares(ledger, position.symbol, stockLeg.quantity, stockLeg.entryPrice, at, "cc_expired_leftover_stock", [position.id]);
    }
    outcome = assigned ? "call_away" : "call_worthless";
  }
  endCycleIfFlat(ledger, position.symbol, at);
  return outcome;
}

/**
 * A split while a cycle is open. The cycle keeps its scale, so nothing is repriced; an open option is now that many more
 * contracts (or fewer), each covering fewer (or more) of the cycle's shares: quantity × N and multiplier ÷ N for an
 * N-for-1 split, the shares it covers unchanged. Done only when the new multiplier and quantity are whole numbers;
 * otherwise the legs are left as they are and `representable` is false (their contracts as traded today cannot be put
 * on the cycle's share scale, so nothing but their expiry can be simulated on them).
 */
export function alignOpenOptionLegsToSplitFactor(ledger: SimulatedLedger, symbol: string, splitFactorToday: number): { representable: boolean; adjustedLegIds: string[] } {
  const cycleSplitFactor = ledger.cycleSplitFactorBySymbol.get(symbol);
  if (cycleSplitFactor === undefined) return { representable: true, adjustedLegIds: [] };
  const sharesPerContractToday = (standardSharesPerContract * splitFactorToday) / cycleSplitFactor;
  const isWhole = (value: number) => value > 0 && Math.abs(value - Math.round(value)) < 1e-9;
  if (!isWhole(sharesPerContractToday)) return { representable: false, adjustedLegIds: [] };
  const symbolPositionIds = new Set(positionsOfSymbol(ledger, symbol).map((position) => position.id));
  const openOptionLegs = ledger.legs.filter((leg) => symbolPositionIds.has(leg.positionId) && leg.legType === "option" && leg.exitAt === null);
  if (openOptionLegs.some((leg) => !isWhole((leg.quantity * leg.multiplier) / sharesPerContractToday))) return { representable: false, adjustedLegIds: [] };
  const adjustedLegIds: string[] = [];
  for (const leg of openOptionLegs) {
    const multiplier = Math.round(sharesPerContractToday);
    if (leg.multiplier === multiplier) continue;
    leg.quantity = Math.round((leg.quantity * leg.multiplier) / multiplier);
    leg.multiplier = multiplier;
    adjustedLegIds.push(leg.id);
  }
  return { representable: true, adjustedLegIds };
}

/** Interest on the cash balance, in dollars as the engine computed it. */
export function creditInterest(ledger: SimulatedLedger, at: Date, interestDollars: number): void {
  recordCash(ledger, { at, kind: "interest", amount: interestDollars, symbol: null, positionId: null, legId: null });
}
