import { breakEvenForPosition, type OpenCycleSummary } from "../../../lib/cycleBreakEven.js";
import { buildCycleInputFromRows, summarizeOpenCycleFromRows, type CycleInputRows, type CycleOptionLegRow, type CycleStockTradeRow } from "../../../lib/cycleInputRows.js";
import { deriveCycles, type Cycle, type CycleInput } from "../../../lib/cycles.js";
import { computeUnrealizedPnlByPosition, type UnrealizedPnlByPosition } from "../../../lib/positionOrderRules.js";
import { availableUncoveredShares, cashLockedInCashSecuredPuts, positionCapitalAtRisk, positionCapitalDeployed, positionRealizedPnl, type PositionFigures, type PositionRealizedPnl } from "../../../lib/positionSelectors.js";
import { easternIsoDate } from "../../../lib/easternIsoDate.js";
import { cycleStartSplitFactor, ledgerRevision, legsOfPosition, openPositionsOf, rememberedForRevision, positionsOfSymbol, requirePosition, unexitedLegsOf, type LedgerLeg, type LedgerPosition, type SimulatedLedger } from "./simulatedLedger.js";

// The simulated book's figures. They come from the functions the platform itself uses, fed with the ledger's rows:
// position figures from positionSelectors.ts (tested against the positions SQL), cycles and the break-even through the
// loaders' own row mapping (cycleInputRows.ts), unrealized P&L from the live function. Only the account value is summed here (live reads it from IBKR). Prices, strikes and share counts are on
// the scale the ledger holds them (the symbol's cycle scale, simulatedLedger.ts); marks passed in must be on it too.

const isOpen = (leg: LedgerLeg) => leg.exitAt === null;

export function ledgerPositionFigures(ledger: SimulatedLedger, position: LedgerPosition): PositionFigures {
  return { strategyKey: position.strategyKey, status: position.status, legs: legsOfPosition(ledger, position.id) };
}

/** Open positions, in the ledger's order (one list per ledger revision). */
function openPositions(ledger: SimulatedLedger): readonly LedgerPosition[] {
  return rememberedForRevision(ledger, "openPositions", () => openPositionsOf(ledger));
}

/** Open legs of open positions, in the ledger's order (one list per ledger revision). */
function openLegs(ledger: SimulatedLedger): readonly { leg: LedgerLeg; position: LedgerPosition }[] {
  return rememberedForRevision(ledger, "openLegs", () => {
    const openPositionById = new Map(openPositions(ledger).map((position) => [position.id, position]));
    return unexitedLegsOf(ledger).flatMap((leg) => {
      const position = openPositionById.get(leg.positionId);
      return position && isOpen(leg) ? [{ leg, position }] : [];
    });
  });
}

/** Uncovered shares of the symbol a call may be written against (fetchAvailableUncoveredShares). Only open positions count, so only they are read. */
export function ledgerFreeShares(ledger: SimulatedLedger, symbol: string): number {
  return availableUncoveredShares(positionsOfSymbol(ledger, symbol).filter((position) => position.status === "open").map((position) => ledgerPositionFigures(ledger, position)));
}

/** Cash reserved for the open cash-secured puts at their full strike (computeCashLockedInCsps). Only open positions count, so only they are read. */
export function ledgerCashLockedInCashSecuredPuts(ledger: SimulatedLedger): number {
  return cashLockedInCashSecuredPuts(openPositions(ledger).map((position) => ledgerPositionFigures(ledger, position)));
}

/** Cash not reserved for the open puts, never below zero (as live's accountContext.ts). */
export function ledgerFreeCash(ledger: SimulatedLedger): number {
  return Math.max(0, ledger.cash - ledgerCashLockedInCashSecuredPuts(ledger));
}

/** EXP $: the capital the position exposes now, net of the premium received (positionSelect's capitalAtRisk). */
export function ledgerCapitalAtRisk(ledger: SimulatedLedger, positionId: string): number | null {
  return positionCapitalAtRisk(ledgerPositionFigures(ledger, requirePosition(ledger, positionId)));
}

/** The P&L % base (positionSelect's capitalDeployed). */
export function ledgerCapitalDeployed(ledger: SimulatedLedger, positionId: string): number | null {
  return positionCapitalDeployed(ledgerPositionFigures(ledger, requirePosition(ledger, positionId)));
}

/** Σ capitalAtRisk of the open positions: the capital Pluto's budget counts as committed (book.ts). */
export function ledgerCommittedDollars(ledger: SimulatedLedger): number {
  return openPositions(ledger).reduce((sum, position) => sum + (positionCapitalAtRisk(ledgerPositionFigures(ledger, position)) ?? 0), 0);
}

function closingCommissionDollarsByLegId(ledger: SimulatedLedger): Map<string, number> {
  const commissionByLegId = new Map<string, number>();
  for (const trade of ledger.trades) if (trade.isClosingTrade) commissionByLegId.set(trade.legId, (commissionByLegId.get(trade.legId) ?? 0) + trade.commission);
  return commissionByLegId;
}

/** A position's realized P&L, split into premium and stock (positionSelect's realizedPnl columns). */
export function ledgerRealizedPnl(ledger: SimulatedLedger, positionId: string): PositionRealizedPnl {
  return positionRealizedPnl(legsOfPosition(ledger, positionId), closingCommissionDollarsByLegId(ledger));
}

/** Realized P&L of every position, open or closed. */
export function ledgerTotalRealizedPnl(ledger: SimulatedLedger): number {
  return positionRealizedPnl(ledger.legs, closingCommissionDollarsByLegId(ledger)).total;
}

/** Each open position's open legs marked to the given prices (computeUnrealizedPnlByPosition): null for a position with a leg that has no price. */
export function ledgerUnrealizedPnl(ledger: SimulatedLedger, priceByLegId: ReadonlyMap<string, number>): UnrealizedPnlByPosition {
  const legs = openLegs(ledger).map(({ leg }) => leg);
  return computeUnrealizedPnlByPosition(openPositions(ledger).map((position) => position.id), legs, Object.fromEntries(legs.map((leg) => [leg.id, priceByLegId.get(leg.id) ?? null])));
}

/** The shares held, long less short, at the marks given (each leg's entry price where none). */
export function ledgerSharesValue(ledger: SimulatedLedger, priceByLegId: ReadonlyMap<string, number>): number {
  return openLegs(ledger).reduce((value, { leg }) => (leg.legType === "stock" ? value + (priceByLegId.get(leg.id) ?? leg.entryPrice) * leg.quantity * leg.multiplier * (leg.side === "short" ? -1 : 1) : value), 0);
}

/** Cash plus every open leg at the given prices, a short option as a liability; a leg with no price counts at its entry price. */
export function ledgerNetLiquidationValue(ledger: SimulatedLedger, priceByLegId: ReadonlyMap<string, number>): number {
  return openLegs(ledger).reduce((value, { leg }) => value + (priceByLegId.get(leg.id) ?? leg.entryPrice) * leg.quantity * leg.multiplier * (leg.side === "short" ? -1 : 1), ledger.cash);
}

function optionLegRows(ledger: SimulatedLedger, symbol: string, expiryCloseByDate: ReadonlyMap<string, number>, splitFactorOn?: (dateIso: string) => number | null): (CycleOptionLegRow & { positionCloseReason: string | null })[] {
  const closingCommissionByLegId = closingCommissionDollarsByLegId(ledger);
  const legIdsWithClosingTrade = new Set(ledger.trades.filter((trade) => trade.isClosingTrade).map((trade) => trade.legId));
  // The timeline's figures from the fills, as the cycle loader reads them (a carved slice reads the leg it was carved from).
  const tradesByLegId = new Map<string, typeof ledger.trades>();
  for (const trade of ledger.trades) {
    const legTrades = tradesByLegId.get(trade.legId);
    if (legTrades) legTrades.push(trade);
    else tradesByLegId.set(trade.legId, [trade]);
  }
  const fillFiguresOf = (legId: string, closing: boolean) => {
    const fills = (tradesByLegId.get(legId) ?? []).filter((trade) => trade.isClosingTrade === closing);
    const quantity = fills.reduce((sum, trade) => sum + trade.quantity, 0);
    // The stock's price at the fills, over the contracts of the fills that know it (cycleQueries.ts optionFillStockPriceSql).
    const withStockPrice = fills.filter((trade) => trade.stockPrice !== undefined);
    const stockPriceQuantity = withStockPrice.reduce((sum, trade) => sum + trade.quantity, 0);
    const stockPrice = stockPriceQuantity > 0 ? withStockPrice.reduce((sum, trade) => sum + trade.stockPrice! * trade.quantity, 0) / stockPriceQuantity : null;
    return { count: fills.length, quantity, price: quantity > 0 ? fills.reduce((sum, trade) => sum + trade.price * trade.quantity, 0) / quantity : null, commission: fills.reduce((sum, trade) => sum + trade.commission, 0), stockPrice };
  };
  // A fill price on its cycle's scale, as traded on the day it filled (× F(day) ÷ the cycle's factor): the timeline's labels.
  const asTradedOn = (leg: LedgerLeg, price: number | null, at: Date | null): number | null => {
    const cycleFactor = splitFactorOn ? cycleStartSplitFactor(ledger, symbol, leg.entryAt) : null;
    const dayFactor = cycleFactor === null || at === null ? null : splitFactorOn!(easternIsoDate(at));
    return price === null || cycleFactor === null || dayFactor === null ? price : (price * dayFactor) / cycleFactor;
  };
  const rows: (CycleOptionLegRow & { positionCloseReason: string | null })[] = [];
  for (const position of positionsOfSymbol(ledger, symbol)) {
    for (const leg of legsOfPosition(ledger, position.id)) {
      if (leg.legType !== "option" || leg.optionType === null || leg.strikePrice === null || leg.expiryDate === null) continue;
      rows.push({
        id: leg.id,
        positionId: position.id,
        tickerId: symbol,
        side: leg.side,
        optionType: leg.optionType,
        strike: leg.strikePrice,
        quantity: leg.quantity,
        multiplier: leg.multiplier,
        entryPrice: leg.entryPrice,
        entryAt: leg.entryAt,
        exitPrice: leg.exitPrice,
        exitAt: leg.exitAt,
        expiryDate: leg.expiryDate,
        closingCommission: closingCommissionByLegId.get(leg.id) ?? 0,
        hasClosingTrade: legIdsWithClosingTrade.has(leg.id),
        expiryClose: leg.expiryClose ?? expiryCloseByDate.get(leg.expiryDate) ?? null,
        positionCloseReason: position.closeReason,
        settledAs: leg.settledAs ?? undefined,
        ...(() => {
          const opening = fillFiguresOf(leg.parentLegId ?? leg.id, false);
          const closing = fillFiguresOf(leg.id, true);
          return {
            openingFillPrice: asTradedOn(leg, opening.price, leg.entryAt),
            openingFillCount: opening.count,
            openingCommission: opening.quantity > 0 ? (opening.commission / opening.quantity) * leg.quantity : null,
            closingFillPrice: asTradedOn(leg, closing.price, leg.exitAt),
            // On the cycle's scale, like the strike: the session's records turn both into prices as traded (timelineAsTraded).
            openingStockPrice: opening.stockPrice,
            closingStockPrice: closing.stockPrice,
          };
        })(),
        ...(position.strategyKey === "leaps" ? { leaps: true } : {}),
      });
    }
  }
  return rows;
}

function stockTradeRows(ledger: SimulatedLedger, symbol: string): CycleStockTradeRow[] {
  const stockLegIds = new Set(positionsOfSymbol(ledger, symbol).flatMap((position) => legsOfPosition(ledger, position.id)).filter((leg) => leg.legType === "stock").map((leg) => leg.id));
  return ledger.trades.filter((trade) => stockLegIds.has(trade.legId)).map((trade) => ({ tickerId: symbol, at: trade.executedAt, side: trade.side, quantity: trade.quantity, price: trade.price, commission: trade.commission }));
}

export interface LedgerCycleMarket {
  /**
   * The symbol's daily closes, ascending by date, on the scale of its open cycle: shares moving between the cycle's
   * buckets are valued at them, and the last one marks the shares still held. A cycle's total does not depend on them
   * once it is closed; only its split between buckets does.
   */
  dailyCloses: readonly { date: string; close: number }[];
  /** Mark per share of open option legs, by leg id. A position missing one for any open option leg stays at its credit, as live does before a nightly mark. */
  optionMarkByLegId?: ReadonlyMap<string, number>;
  /** F on a date (splitFactors.ts): with it, the timeline's fill prices read as traded on their day, not on the cycle's scale. */
  splitFactorOn?: (dateIso: string) => number | null;
}

/** The open positions' option premium P&L at the marks given (none without marks), by position. */
function openPositionPremiumPnlOf(ledger: SimulatedLedger, symbolPositions: readonly LedgerPosition[], market: LedgerCycleMarket): Map<string, number> {
  const openPositionPremiumPnl = new Map<string, number>();
  if (market.optionMarkByLegId) {
    const openOptionLegs = symbolPositions.filter((position) => position.status === "open").flatMap((position) => legsOfPosition(ledger, position.id)).filter((leg) => leg.legType === "option" && isOpen(leg));
    const marked = computeUnrealizedPnlByPosition([...new Set(openOptionLegs.map((leg) => leg.positionId))], openOptionLegs, Object.fromEntries(openOptionLegs.map((leg) => [leg.id, market.optionMarkByLegId!.get(leg.id) ?? null])));
    for (const [positionId, premiumPnl] of Object.entries(marked.premiumByPositionId)) if (premiumPnl !== null) openPositionPremiumPnl.set(positionId, premiumPnl);
  }
  return openPositionPremiumPnl;
}

/** The rows the cycle loader would select for the symbol (cycleQueries.ts), from the ledger. The symbol stands in for the ticker id. */
export function ledgerCycleInputRows(ledger: SimulatedLedger, symbol: string, market: LedgerCycleMarket): CycleInputRows {
  const symbolPositions = positionsOfSymbol(ledger, symbol);
  const openPositionPremiumPnl = openPositionPremiumPnlOf(ledger, symbolPositions, market);
  return {
    optionRows: optionLegRows(ledger, symbol, new Map(market.dailyCloses.map((bar) => [bar.date, bar.close])), market.splitFactorOn),
    stockLegRows: symbolPositions.flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.legType === "stock" && leg.side === "long").map((leg) => ({ tickerId: symbol, positionId: position.id, quantity: leg.quantity, entryAt: leg.entryAt, exitAt: leg.exitAt }))),
    stockTradeRows: stockTradeRows(ledger, symbol),
    barRows: market.dailyCloses.map((bar) => ({ tickerId: symbol, date: bar.date, close: bar.close })),
    openPositionPremiumPnl,
  };
}

/**
 * ledgerCycleInput without the open positions' marked premium, per ledger, symbol and closes array, kept for one
 * ledger revision: most looks read the same book over the same day's closes, and only the marks move.
 */
const cycleInputBookByLedger = new WeakMap<SimulatedLedger, Map<string, { revision: number; dailyCloses: LedgerCycleMarket["dailyCloses"]; splitFactorOn: LedgerCycleMarket["splitFactorOn"]; input: CycleInput }>>();

export function ledgerCycleInput(ledger: SimulatedLedger, symbol: string, market: LedgerCycleMarket): CycleInput {
  let bySymbol = cycleInputBookByLedger.get(ledger);
  if (!bySymbol) cycleInputBookByLedger.set(ledger, (bySymbol = new Map()));
  const revision = ledgerRevision(ledger);
  let kept = bySymbol.get(symbol);
  if (!kept || kept.revision !== revision || kept.dailyCloses !== market.dailyCloses || kept.splitFactorOn !== market.splitFactorOn) {
    kept = { revision, dailyCloses: market.dailyCloses, splitFactorOn: market.splitFactorOn, input: buildCycleInputFromRows(symbol, ledgerCycleInputRows(ledger, symbol, { dailyCloses: market.dailyCloses, ...(market.splitFactorOn ? { splitFactorOn: market.splitFactorOn } : {}) })) };
    bySymbol.set(symbol, kept);
  }
  return { ...kept.input, openPositionPremiumPnl: openPositionPremiumPnlOf(ledger, positionsOfSymbol(ledger, symbol), market) };
}

/** The symbol's wheel cycles, open and closed (deriveCycles). */
export function ledgerCycles(ledger: SimulatedLedger, symbol: string, market: LedgerCycleMarket): Cycle[] {
  return deriveCycles(ledgerCycleInput(ledger, symbol, market));
}

/** ledgerOpenCycleSummary per ledger and symbol, kept for one ledger revision (it reads the book alone). */
const openCycleSummaryByLedger = new WeakMap<SimulatedLedger, Map<string, { revision: number; summary: OpenCycleSummary | null }>>();

/** The symbol's open cycle (summarizeOpenCycle, from the short option legs and stock fills the live loader passes); null when it is flat. */
export function ledgerOpenCycleSummary(ledger: SimulatedLedger, symbol: string): OpenCycleSummary | null {
  let bySymbol = openCycleSummaryByLedger.get(ledger);
  if (!bySymbol) openCycleSummaryByLedger.set(ledger, (bySymbol = new Map()));
  const revision = ledgerRevision(ledger);
  const kept = bySymbol.get(symbol);
  if (kept && kept.revision === revision) return kept.summary;
  const summary = summarizeLedgerOpenCycle(ledger, symbol);
  bySymbol.set(symbol, { revision, summary });
  return summary;
}

function summarizeLedgerOpenCycle(ledger: SimulatedLedger, symbol: string): OpenCycleSummary | null {
  const openStockShares = positionsOfSymbol(ledger, symbol).flatMap((position) => legsOfPosition(ledger, position.id)).filter((leg) => leg.legType === "stock" && leg.side === "long" && isOpen(leg)).reduce((sum, leg) => sum + leg.quantity, 0);
  return summarizeOpenCycleFromRows(symbol, { optionRows: optionLegRows(ledger, symbol, new Map()), stockTradeRows: stockTradeRows(ledger, symbol), openStockShares });
}

/** An open position's break-even (the Positions column): its cycle's per share, or a put-only cycle's own strike less the premium. */
export function ledgerBreakEvenForPosition(ledger: SimulatedLedger, positionId: string): { breakEven: number | null; reason: string | null } {
  const summary = ledgerOpenCycleSummary(ledger, requirePosition(ledger, positionId).symbol);
  return summary === null ? { breakEven: null, reason: "no open cycle on the symbol" } : breakEvenForPosition(summary, positionId);
}

/** Open short option legs whose expiry date is on or before `dateIso`: what the day's settlement has to settle. */
export function ledgerLegsDueForSettlement(ledger: SimulatedLedger, dateIso: string): LedgerLeg[] {
  return openLegs(ledger).flatMap(({ leg }) => (leg.legType === "option" && leg.side === "short" && leg.expiryDate !== null && leg.expiryDate <= dateIso ? [leg] : []));
}

/** Open LEAPS Calls whose expiry date is on or before `dateIso`: what the day's settlement settles of those held to expiry. */
export function ledgerLeapsLegsDueForSettlement(ledger: SimulatedLedger, dateIso: string): LedgerLeg[] {
  return openLegs(ledger).flatMap(({ leg, position }) => (position.strategyKey === "leaps" && leg.legType === "option" && leg.expiryDate !== null && leg.expiryDate <= dateIso ? [leg] : []));
}
