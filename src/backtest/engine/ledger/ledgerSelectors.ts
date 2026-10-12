import { breakEvenForPosition, type OpenCycleSummary } from "../../../lib/cycleBreakEven.js";
import { buildCycleInputFromRows, summarizeOpenCycleFromRows, type CycleInputRows, type CycleOptionLegRow, type CycleStockTradeRow } from "../../../lib/cycleInputRows.js";
import { deriveCycles, type Cycle, type CycleInput } from "../../../lib/cycles.js";
import { daysToExpiry, describeOptionContract } from "../../../lib/optionContractLabel.js";
import { computeExposureRows, type PositionExposureRow } from "../../../lib/positionExposure.js";
import { computeUnrealizedPnlByPosition, type UnrealizedPnlByPosition } from "../../../lib/positionOrderRules.js";
import { availableUncoveredShares, cashLockedInCashSecuredPuts, positionCapitalAtRisk, positionCapitalDeployed, positionRealizedPnl, type PositionFigures, type PositionRealizedPnl } from "../../../lib/positionSelectors.js";
import type { OpenShortLeg } from "../../../lib/rollSignalCandidates.js";
import { findSameContractConflict, type OccupiedContract } from "../../../pluto/candidateFilters.js";
import type { PostModelBookInput } from "../../../pluto/postModelGates.js";
import { legsOfPosition, positionsOfSymbol, requirePosition, type LedgerLeg, type LedgerPosition, type SimulatedLedger } from "./simulatedLedger.js";

// Pluto's view of the simulated book. The figures come from the functions the platform itself uses, fed with the
// ledger's rows: position figures from positionSelectors.ts (tested against the positions SQL), cycles and the
// break-even through the loaders' own row mapping (cycleInputRows.ts), exposure and unrealized P&L from the live
// functions. Only the account value is summed here (live reads it from IBKR). Prices, strikes and share counts are on
// the scale the ledger holds them (the symbol's cycle scale, simulatedLedger.ts); marks passed in must be on it too.

const isOpen = (leg: LedgerLeg) => leg.exitAt === null;

export function ledgerPositionFigures(ledger: SimulatedLedger, position: LedgerPosition): PositionFigures {
  return { strategyKey: position.strategyKey, status: position.status, legs: legsOfPosition(ledger, position.id) };
}

function openPositions(ledger: SimulatedLedger): LedgerPosition[] {
  return ledger.positions.filter((position) => position.status === "open");
}

/** Open legs of open positions, in the ledger's order. */
function openLegs(ledger: SimulatedLedger): { leg: LedgerLeg; position: LedgerPosition }[] {
  const openPositionById = new Map(openPositions(ledger).map((position) => [position.id, position]));
  return ledger.legs.flatMap((leg) => {
    const position = openPositionById.get(leg.positionId);
    return position && isOpen(leg) ? [{ leg, position }] : [];
  });
}

/** Uncovered shares of the symbol a call may be written against (fetchAvailableUncoveredShares). */
export function ledgerFreeShares(ledger: SimulatedLedger, symbol: string): number {
  return availableUncoveredShares(positionsOfSymbol(ledger, symbol).map((position) => ledgerPositionFigures(ledger, position)));
}

/** Cash reserved for the open cash-secured puts at their full strike (computeCashLockedInCsps). */
export function ledgerCashLockedInCashSecuredPuts(ledger: SimulatedLedger): number {
  return cashLockedInCashSecuredPuts(ledger.positions.map((position) => ledgerPositionFigures(ledger, position)));
}

/** Cash not reserved for the open puts, never below zero (signalsStore's account context). */
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

/**
 * Each open position's exposure at the given prices (computeExposureRows): its legs at market, a short option as a
 * liability, a cash-secured put plus its strike collateral. A leg with no price counts at its entry price, as live does.
 */
export function ledgerExposureRows(ledger: SimulatedLedger, priceByLegId: ReadonlyMap<string, number>, sectorBySymbol: ReadonlyMap<string, string | null>): PositionExposureRow[] {
  const legs = openLegs(ledger);
  const positionRows = openPositions(ledger).map((position) => ({ positionId: position.id, strategyKey: position.strategyKey, symbol: position.symbol, sector: sectorBySymbol.get(position.symbol) || "Unknown" }));
  const legRows = legs.map(({ leg, position }) => ({
    positionId: position.id,
    strategyKey: position.strategyKey,
    legType: leg.legType,
    side: leg.side,
    quantity: leg.quantity,
    multiplier: leg.multiplier,
    entryPrice: String(leg.entryPrice),
    optionType: leg.optionType,
    strikePrice: leg.strikePrice === null ? null : String(leg.strikePrice),
    expiryDate: leg.expiryDate === null ? null : leg.expiryDate.replaceAll("-", ""),
    symbol: position.symbol,
  }));
  return computeExposureRows(positionRows, legRows, Object.fromEntries(legs.map(({ leg }, index) => [String(index), priceByLegId.get(leg.id) ?? null])));
}

/** Cash plus every open leg at the given prices, a short option as a liability; a leg with no price counts at its entry price. */
export function ledgerNetLiquidationValue(ledger: SimulatedLedger, priceByLegId: ReadonlyMap<string, number>): number {
  return openLegs(ledger).reduce((value, { leg }) => value + (priceByLegId.get(leg.id) ?? leg.entryPrice) * leg.quantity * leg.multiplier * (leg.side === "short" ? -1 : 1), ledger.cash);
}

function optionLegRows(ledger: SimulatedLedger, symbol: string, expiryCloseByDate: ReadonlyMap<string, number>): (CycleOptionLegRow & { positionCloseReason: string | null })[] {
  const closingCommissionByLegId = closingCommissionDollarsByLegId(ledger);
  const legIdsWithClosingTrade = new Set(ledger.trades.filter((trade) => trade.isClosingTrade).map((trade) => trade.legId));
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
}

/** The rows the cycle loader would select for the symbol (cycleQueries.ts), from the ledger. The symbol stands in for the ticker id. */
export function ledgerCycleInputRows(ledger: SimulatedLedger, symbol: string, market: LedgerCycleMarket): CycleInputRows {
  const symbolPositions = positionsOfSymbol(ledger, symbol);
  const openPositionPremiumPnl = new Map<string, number>();
  if (market.optionMarkByLegId) {
    const openOptionLegs = symbolPositions.filter((position) => position.status === "open").flatMap((position) => legsOfPosition(ledger, position.id)).filter((leg) => leg.legType === "option" && isOpen(leg));
    const marked = computeUnrealizedPnlByPosition([...new Set(openOptionLegs.map((leg) => leg.positionId))], openOptionLegs, Object.fromEntries(openOptionLegs.map((leg) => [leg.id, market.optionMarkByLegId!.get(leg.id) ?? null])));
    for (const [positionId, premiumPnl] of Object.entries(marked.premiumByPositionId)) if (premiumPnl !== null) openPositionPremiumPnl.set(positionId, premiumPnl);
  }
  return {
    optionRows: optionLegRows(ledger, symbol, new Map(market.dailyCloses.map((bar) => [bar.date, bar.close]))),
    stockLegRows: symbolPositions.flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.legType === "stock" && leg.side === "long").map((leg) => ({ tickerId: symbol, positionId: position.id, quantity: leg.quantity, entryAt: leg.entryAt, exitAt: leg.exitAt }))),
    stockTradeRows: stockTradeRows(ledger, symbol),
    barRows: market.dailyCloses.map((bar) => ({ tickerId: symbol, date: bar.date, close: bar.close })),
    openPositionPremiumPnl,
  };
}

export function ledgerCycleInput(ledger: SimulatedLedger, symbol: string, market: LedgerCycleMarket): CycleInput {
  return buildCycleInputFromRows(symbol, ledgerCycleInputRows(ledger, symbol, market));
}

/** The symbol's wheel cycles, open and closed (deriveCycles). */
export function ledgerCycles(ledger: SimulatedLedger, symbol: string, market: LedgerCycleMarket): Cycle[] {
  return deriveCycles(ledgerCycleInput(ledger, symbol, market));
}

/** The symbol's open cycle (summarizeOpenCycle, from the short option legs and stock fills the live loader passes); null when it is flat. */
export function ledgerOpenCycleSummary(ledger: SimulatedLedger, symbol: string): OpenCycleSummary | null {
  const openStockShares = positionsOfSymbol(ledger, symbol).flatMap((position) => legsOfPosition(ledger, position.id)).filter((leg) => leg.legType === "stock" && leg.side === "long" && isOpen(leg)).reduce((sum, leg) => sum + leg.quantity, 0);
  return summarizeOpenCycleFromRows(symbol, { optionRows: optionLegRows(ledger, symbol, new Map()).filter((row) => row.side === "short"), stockTradeRows: stockTradeRows(ledger, symbol), openStockShares });
}

/** An open position's break-even (the Positions column): its cycle's per share, or a put-only cycle's own strike less the premium. */
export function ledgerBreakEvenForPosition(ledger: SimulatedLedger, positionId: string): { breakEven: number | null; reason: string | null } {
  const summary = ledgerOpenCycleSummary(ledger, requirePosition(ledger, positionId).symbol);
  return summary === null ? { breakEven: null, reason: "no open cycle on the symbol" } : breakEvenForPosition(summary, positionId);
}

function openOptionLegsOfSymbol(ledger: SimulatedLedger, symbol: string): { leg: LedgerLeg; position: LedgerPosition }[] {
  return openLegs(ledger).filter(({ leg, position }) => position.symbol === symbol && leg.legType === "option");
}

/** Every contract on the symbol already held (loadOccupiedContracts; a simulated order fills at once, so none is ever working). */
export function ledgerOccupiedContracts(ledger: SimulatedLedger, symbol: string, todayIso: string): OccupiedContract[] {
  return openOptionLegsOfSymbol(ledger, symbol).flatMap(({ leg }) =>
    leg.expiryDate === null || leg.strikePrice === null || leg.optionType === null
      ? []
      : [{ expiry: leg.expiryDate, strike: leg.strikePrice, detail: `open position on ${describeOptionContract({ symbol, strike: leg.strikePrice, right: leg.optionType === "call" ? "C" : "P", expiry: leg.expiryDate, dte: daysToExpiry(leg.expiryDate, todayIso) })}` }],
  );
}

/** The symbol's open short option legs as scoring reads them (loadOpenShortLegs), by expiry then strike. */
export function ledgerOpenShortLegs(ledger: SimulatedLedger, symbol: string): OpenShortLeg[] {
  const legs: OpenShortLeg[] = [];
  for (const { leg, position } of openOptionLegsOfSymbol(ledger, symbol)) {
    if (leg.side !== "short" || leg.expiryDate === null || leg.strikePrice === null || leg.optionType === null) continue;
    if (position.strategyKey !== "covered_call" && position.strategyKey !== "cash_secured_put") continue;
    legs.push({ legId: leg.id, positionId: position.id, strategyKey: position.strategyKey, expiry: leg.expiryDate, strike: leg.strikePrice, right: leg.optionType === "call" ? "C" : "P", quantity: leg.quantity, entryPrice: leg.entryPrice, entryAtIso: leg.entryAt.toISOString() });
  }
  return legs.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
}

/** Open short option legs whose expiry date is on or before `dateIso`: what the day's settlement has to settle. */
export function ledgerLegsDueForSettlement(ledger: SimulatedLedger, dateIso: string): LedgerLeg[] {
  return openLegs(ledger).flatMap(({ leg }) => (leg.legType === "option" && leg.side === "short" && leg.expiryDate !== null && leg.expiryDate <= dateIso ? [leg] : []));
}

/** When a simulated Pluto action last filled on the symbol (the ticker cooldown's clock); null if never. */
export function ledgerLastFilledActionAt(ledger: SimulatedLedger, symbol: string): Date | null {
  const legIds = new Set(positionsOfSymbol(ledger, symbol).flatMap((position) => legsOfPosition(ledger, position.id)).map((leg) => leg.id));
  let latest: Date | null = null;
  for (const trade of ledger.trades) if (trade.actionId !== null && legIds.has(trade.legId) && (latest === null || trade.executedAt.getTime() > latest.getTime())) latest = trade.executedAt;
  return latest;
}

export interface LedgerPostModelBookRequest {
  symbol: string;
  sector: string | null;
  /** The contract about to be ordered, for the one-position-per-contract check. */
  contract: { expiry: string; strike: number };
  /** Mark per share of every open leg, by leg id (ledgerExposureRows, ledgerNetLiquidationValue). */
  priceByLegId: ReadonlyMap<string, number>;
  sectorBySymbol: ReadonlyMap<string, string | null>;
  spotPrice: number | null;
  todayIso: string;
  nowMs: number;
}

/** The book figures Pluto's post-model gates size against (runPostModelGates), as passRunner assembles them. A simulated order fills at once, so nothing is ever in flight. */
export function ledgerPostModelBook(ledger: SimulatedLedger, request: LedgerPostModelBookRequest): PostModelBookInput {
  const exposures = ledgerExposureRows(ledger, request.priceByLegId, request.sectorBySymbol);
  return {
    netLiquidationValue: ledgerNetLiquidationValue(ledger, request.priceByLegId),
    freeCash: ledgerFreeCash(ledger),
    committedDollars: ledgerCommittedDollars(ledger),
    inFlight: { totalNotional: 0, tickerNotional: 0, managedNotional: 0 },
    openPositionCount: openPositions(ledger).length,
    existingTickerExposure: exposures.filter((row) => row.symbol === request.symbol).reduce((sum, row) => sum + row.exposure, 0),
    existingSectorExposure: request.sector === null ? 0 : exposures.filter((row) => row.sector === request.sector).reduce((sum, row) => sum + row.exposure, 0),
    freeShares: ledgerFreeShares(ledger, request.symbol),
    spotPrice: request.spotPrice,
    workingOrderOnSymbol: false,
    lastFilledActionAt: ledgerLastFilledActionAt(ledger, request.symbol),
    nowMs: request.nowMs,
    sameContractConflict: findSameContractConflict(ledgerOccupiedContracts(ledger, request.symbol, request.todayIso), request.contract.expiry, request.contract.strike),
  };
}
