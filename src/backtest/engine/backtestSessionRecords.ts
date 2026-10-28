import type { Cycle } from "../../lib/cycles.js";
import { easternIsoDate } from "../../lib/easternIsoDate.js";
import { daysToExpiry } from "../../lib/optionContractLabel.js";
import { legRealizedPnl } from "../../lib/positionSelectors.js";
import { addCalendarDays } from "../../lib/calendarDays.js";
import type { BacktestAction, BacktestCycle, BacktestCycleDetail, BacktestCycleGap, BacktestCycleTimelineRow, BacktestFill, BacktestPosition, BacktestPositionLeg, BacktestTrade } from "../backtestTypes.js";
import { buildCycleGaps, buildStockOnlyStretches, closeLookupOf, type NoSaleRecords } from "./backtestIdleStretches.js";
import { shareDirectionOf } from "../cycleCashBreakEven.js";
import type { BacktestOptionSale } from "./backtestLookTypes.js";
import type { BacktestTradingCalendar } from "./backtestTradingCalendar.js";
import { ledgerCapitalAtRisk, ledgerCapitalDeployed, ledgerCycles, ledgerRealizedPnl, ledgerUnrealizedPnl } from "./ledger/ledgerSelectors.js";
import { cycleStartSplitFactor, legsOfPosition, positionsOfSymbol, requireLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";

// What a finished session stores, built from its simulated ledger: the positions with their legs, the fills, the wheel
// cycles (the platform's own derivation, deriveCycles) with their timelines and stock-only stretches, the gaps between
// cycles (backtestIdleStretches.ts) and one row per option sold.
//
//   an option sold     = its facts as traded, how it ended, its position's P&L as the platform counts a position's
//                        (realized premium and stock parts after commissions, plus what an open position still holds at
//                        the last marks) and the wheel cycle it was sold in, with the cycle's total. It has no P&L of
//                        its own: whether it made money is the cycle's answer (Marcelo 2026-10-12).
//   recovery sessions  = trading sessions after the day a put of the cycle was first assigned, up to the day it closed
//   age sessions       = for an open cycle, the same count up to the session's last day (from the opening when no put
//                        was assigned)
// A cycle is derived with the daily closes on its own price scale (F of its first day × IBKR's split-adjusted close).

export type SimulatedTrade = Omit<BacktestTrade, "id">;

export interface SessionRecordInputs {
  ledger: SimulatedLedger;
  symbols: readonly string[];
  optionSales: readonly BacktestOptionSale[];
  actions: readonly BacktestAction[];
  /** The mark per share of every open leg at the session's last look, on its cycle's scale. */
  priceByLegId: ReadonlyMap<string, number>;
  /** Per symbol: IBKR's split-adjusted daily closes before the session's last day, then that day's 10:00 stock price ÷ F as its last entry. */
  adjustedDailyClosesBySymbol: ReadonlyMap<string, readonly { date: string; close: number }[]>;
  /** The symbol's cumulative split factor on a date; null when it is not known. */
  splitFactorOn(symbol: string, dateIso: string): number | null;
  calendar: BacktestTradingCalendar;
  lastSessionDateIso: string;
  /** Per symbol: its first and last session days (the days its file holds), for its gaps and stock-only stretches. */
  sessionDaysBySymbol: ReadonlyMap<string, { firstDay: string; lastDay: string }>;
  /** Per symbol: every IBKR split-adjusted daily close in its file, ascending (the stock moves). */
  allAdjustedDailyClosesBySymbol: ReadonlyMap<string, readonly { date: string; close: number }[]>;
  /** What the looks recorded about sales not made. */
  noSaleRecords: NoSaleRecords;
}

/** A cycle with its detail, as a finished session stores it (its No Call runs are read from its legs when the session is read). */
export type BacktestCycleRecord = BacktestCycle & Omit<BacktestCycleDetail, "noCallRuns">;

function closingCommissionByLegId(ledger: SimulatedLedger): Map<string, number> {
  const commissionByLegId = new Map<string, number>();
  for (const trade of ledger.trades) if (trade.isClosingTrade) commissionByLegId.set(trade.legId, (commissionByLegId.get(trade.legId) ?? 0) + trade.commission);
  return commissionByLegId;
}

/** Each cycle of the symbol, derived with the closes on that cycle's own scale, and the scale's split factor (the one the ledger started it on). */
export function deriveCyclesOnTheirOwnScales(inputs: Pick<SessionRecordInputs, "ledger" | "priceByLegId" | "adjustedDailyClosesBySymbol" | "splitFactorOn">, symbol: string): { cycle: Cycle; splitFactor: number }[] {
  const adjustedCloses = inputs.adjustedDailyClosesBySymbol.get(symbol) ?? [];
  const derivedByFactor = new Map<number, Cycle[]>();
  const derivedOnScale = (splitFactor: number): Cycle[] => {
    let derived = derivedByFactor.get(splitFactor);
    if (!derived) {
      derived = ledgerCycles(inputs.ledger, symbol, { dailyCloses: adjustedCloses.map((bar) => ({ date: bar.date, close: bar.close * splitFactor })), optionMarkByLegId: inputs.priceByLegId, splitFactorOn: (dateIso) => inputs.splitFactorOn(symbol, dateIso) });
      derivedByFactor.set(splitFactor, derived);
    }
    return derived;
  };
  // A cycle's boundaries come from the legs alone, so every derivation lists the same cycles in the same order.
  return derivedOnScale(1).map((cycle, index) => {
    const splitFactor = cycleStartSplitFactor(inputs.ledger, symbol, cycle.startAt) ?? inputs.splitFactorOn(symbol, easternIsoDate(cycle.startAt)) ?? 1;
    return { cycle: derivedOnScale(splitFactor)[index]!, splitFactor };
  });
}

/** The cycle's timeline rows with prices and shares as traded on each row's day (a stored price ÷ the cycle's factor × the day's). */
function timelineAsTraded(cycle: Cycle, cycleSplitFactor: number, splitFactorOnDay: (dateIso: string) => number | null, lastSessionDateIso: string): BacktestCycleTimelineRow[] {
  return cycle.timeline.map((row) => {
    const tradingDate = row.at === null ? (row.markDate ?? lastSessionDateIso) : easternIsoDate(row.at);
    const priceScale = cycleSplitFactor / (splitFactorOnDay(tradingDate) ?? cycleSplitFactor);
    return {
      at: row.at?.toISOString() ?? null,
      tradingDate,
      label: row.label,
      bucket: row.bucket,
      instrument: row.instrument,
      quantity: row.quantity * priceScale,
      strike: row.strike === null ? null : row.strike / priceScale,
      expiryDate: row.expiryDate,
      stockPrice: row.stockPrice === null ? null : row.stockPrice / priceScale,
      stockPriceSource: row.stockPriceSource,
      commissionDollars: row.commission,
      premiumDollars: row.premium,
      stockDollars: row.stock,
      unrealized: row.unrealized === true,
    };
  });
}

export function buildCycleRecords(inputs: SessionRecordInputs): BacktestCycleRecord[] {
  const records: BacktestCycleRecord[] = [];
  for (const symbol of inputs.symbols) {
    const symbolPositionIds = new Set(positionsOfSymbol(inputs.ledger, symbol).map((position) => position.id));
    const symbolLegs = inputs.ledger.legs.filter((leg) => symbolPositionIds.has(leg.positionId));
    const assignedPutLegs = symbolLegs.filter((leg) => leg.optionType === "put" && leg.settledAs === "assigned" && leg.exitAt !== null);
    const closes = closeLookupOf(inputs.allAdjustedDailyClosesBySymbol.get(symbol) ?? []);
    const splitFactorOnDay = (dateIso: string) => inputs.splitFactorOn(symbol, dateIso);
    const lastDay = inputs.sessionDaysBySymbol.get(symbol)?.lastDay ?? inputs.lastSessionDateIso;
    deriveCyclesOnTheirOwnScales(inputs, symbol).forEach(({ cycle, splitFactor }, index) => {
      const openedOn = easternIsoDate(cycle.startAt);
      const closedOn = cycle.endAt === null ? null : easternIsoDate(cycle.endAt);
      const assignmentInstants = assignedPutLegs.map((leg) => leg.exitAt!.getTime()).filter((at) => at >= cycle.startAt.getTime() && (cycle.endAt === null || at <= cycle.endAt.getTime()));
      const assignedOn = assignmentInstants.length === 0 ? null : easternIsoDate(new Date(Math.min(...assignmentInstants)));
      const sessionsAfter = (fromIso: string, throughIso: string) => inputs.calendar.openDaysBetween(addCalendarDays(fromIso, 1), throughIso).length;
      records.push({
        symbol,
        cycleNumber: index + 1,
        status: cycle.status,
        openedAt: cycle.startAt.toISOString(),
        closedAt: cycle.endAt?.toISOString() ?? null,
        openedOn,
        closedOn,
        assignedOn,
        recoverySessions: closedOn !== null && assignedOn !== null ? sessionsAfter(assignedOn, closedOn) : null,
        ageSessions: closedOn === null ? sessionsAfter(assignedOn ?? openedOn, inputs.lastSessionDateIso) : null,
        totalDollars: cycle.total,
        netPremiumDollars: cycle.netPremium,
        sharesHeld: cycle.sharesHeld,
        breakEvenPerShare: cycle.breakEvenPerShare,
        buckets: cycle.buckets,
        dataFlags: cycle.dataFlags,
        timeline: timelineAsTraded(cycle, splitFactor, splitFactorOnDay, inputs.lastSessionDateIso),
        stockOnlyStretches: buildStockOnlyStretches({
          symbol,
          cycle: { openedOn, closedOn },
          lastDay,
          legs: symbolLegs,
          calendar: inputs.calendar,
          closes,
          records: inputs.noSaleRecords,
          sharesHeldAt: (atMs) => cycle.timeline.reduce((held, row) => held + (row.at !== null && row.at.getTime() <= atMs ? shareDirectionOf(row.label) * row.quantity : 0), 0),
          sharesAsTradedOn: (dateIso) => splitFactor / (splitFactorOnDay(dateIso) ?? splitFactor),
        }),
      });
    });
  }
  return records;
}

/** Each symbol's stretches with no cycle open, symbol by symbol, oldest first. */
export function buildCycleGapRecords(inputs: Pick<SessionRecordInputs, "symbols" | "calendar" | "sessionDaysBySymbol" | "allAdjustedDailyClosesBySymbol" | "noSaleRecords">, cycles: readonly BacktestCycle[]): BacktestCycleGap[] {
  return inputs.symbols.flatMap((symbol) => {
    const days = inputs.sessionDaysBySymbol.get(symbol);
    if (!days) return [];
    return buildCycleGaps({
      symbol,
      cycles: cycles.filter((cycle) => cycle.symbol === symbol).sort((a, b) => a.cycleNumber - b.cycleNumber),
      firstDay: days.firstDay,
      lastDay: days.lastDay,
      calendar: inputs.calendar,
      closes: closeLookupOf(inputs.allAdjustedDailyClosesBySymbol.get(symbol) ?? []),
      records: inputs.noSaleRecords,
    });
  });
}

/**
 * Reads, for a symbol and an instant, the price scale of the ledger's rows there: the split factor of the cycle the
 * instant falls in ÷ the split factor of its day (a stored price ÷ this is the price as traded that day).
 */
function cyclePriceScaleReader(inputs: Pick<SessionRecordInputs, "ledger" | "symbols" | "priceByLegId" | "adjustedDailyClosesBySymbol" | "splitFactorOn">): (symbol: string, at: Date) => number {
  const cycleWindowsBySymbol = new Map(inputs.symbols.map((symbol) => [symbol, deriveCyclesOnTheirOwnScales(inputs, symbol)]));
  return (symbol, at) => {
    const atMs = at.getTime();
    const owner = (cycleWindowsBySymbol.get(symbol) ?? []).find(({ cycle }) => atMs >= cycle.startAt.getTime() && (cycle.endAt === null || atMs <= cycle.endAt.getTime()));
    const dayFactor = inputs.splitFactorOn(symbol, easternIsoDate(at));
    return owner && dayFactor !== null ? owner.splitFactor / dayFactor : 1;
  };
}

/** A position as the book records it, before it is matched to its wheel cycle. */
export type BacktestPositionRecord = Omit<BacktestPosition, "cycleNumber" | "cycleLabel">;

/** The symbol's wheel cycle running at an instant: opened at or before it and not closed before it (the first one when two meet). */
export function cycleRunningAt<Cycle extends Pick<BacktestCycle, "symbol" | "cycleNumber" | "openedAt" | "closedAt">>(cycles: readonly Cycle[], symbol: string, atMs: number): Cycle | null {
  return cycles.find((entry) => entry.symbol === symbol && Date.parse(entry.openedAt) <= atMs && (entry.closedAt === null || atMs <= Date.parse(entry.closedAt))) ?? null;
}

/** A position with the cycle of its symbol that was running when it opened. */
export function withPositionCycle(position: BacktestPositionRecord, cycles: readonly Pick<BacktestCycle, "symbol" | "cycleNumber" | "openedAt" | "closedAt">[]): BacktestPosition {
  const cycle = cycleRunningAt(cycles, position.symbol, Date.parse(position.openedAt));
  return { ...position, cycleNumber: cycle?.cycleNumber ?? null, cycleLabel: cycle ? describeCycle(cycle.symbol, cycle.cycleNumber) : null };
}

export function buildPositionRecords(inputs: SessionRecordInputs): BacktestPositionRecord[] {
  const { ledger } = inputs;
  const closingCommissions = closingCommissionByLegId(ledger);
  const unrealized = ledgerUnrealizedPnl(ledger, inputs.priceByLegId).unrealizedByPositionId;
  const priceScaleAt = cyclePriceScaleReader(inputs);
  return ledger.positions.map((position) => {
    const realized = ledgerRealizedPnl(ledger, position.id);
    const legs: BacktestPositionLeg[] = legsOfPosition(ledger, position.id).map((leg) => ({
      legId: leg.id,
      parentLegId: leg.parentLegId,
      legType: leg.legType,
      side: leg.side,
      quantity: leg.quantity,
      optionType: leg.optionType,
      strike: leg.strikePrice,
      expiry: leg.expiryDate,
      multiplier: leg.multiplier,
      entryPrice: leg.entryPrice,
      entryAt: leg.entryAt.toISOString(),
      exitPrice: leg.exitPrice,
      exitAt: leg.exitAt?.toISOString() ?? null,
      settledAs: leg.settledAs,
      expiryClose: leg.expiryClose,
      dteAtEntry: leg.legType === "option" && leg.expiryDate !== null ? daysToExpiry(leg.expiryDate, easternIsoDate(leg.entryAt)) : null,
      realizedPnlDollars: leg.exitPrice === null ? null : legRealizedPnl({ ...leg, exitPrice: leg.exitPrice }, closingCommissions.get(leg.id) ?? 0),
      priceScale: priceScaleAt(position.symbol, leg.entryAt),
    }));
    return {
      positionId: position.id,
      symbol: position.symbol,
      strategyKey: position.strategyKey,
      status: position.status,
      openedAt: position.openedAt.toISOString(),
      closedAt: position.closedAt?.toISOString() ?? null,
      closeReason: position.closeReason,
      unstructuredReason: position.unstructuredReason,
      capitalAtRiskDollars: ledgerCapitalAtRisk(ledger, position.id),
      capitalDeployedDollars: ledgerCapitalDeployed(ledger, position.id),
      realizedPnlDollars: realized.total,
      realizedPremiumPnlDollars: realized.premium,
      realizedStockPnlDollars: realized.stock,
      unrealizedPnlDollars: position.status === "open" ? (unrealized[position.id] ?? null) : null,
      shareSourcePositionIds: ledger.shareSources.filter((source) => source.positionId === position.id).map((source) => source.sourcePositionId),
      legs,
    };
  });
}

export function buildFillRecords(inputs: Pick<SessionRecordInputs, "ledger" | "symbols" | "priceByLegId" | "adjustedDailyClosesBySymbol" | "splitFactorOn">): BacktestFill[] {
  const { ledger } = inputs;
  const positionById = new Map(ledger.positions.map((position) => [position.id, position]));
  const priceScaleAt = cyclePriceScaleReader(inputs);
  return ledger.trades.map((trade) => {
    const leg = requireLeg(ledger, trade.legId);
    const symbol = positionById.get(leg.positionId)!.symbol;
    return {
      fillId: trade.id,
      positionId: leg.positionId,
      legId: leg.id,
      symbol,
      instrument: leg.legType,
      side: trade.side,
      quantity: trade.quantity,
      // Every option trade is for its whole leg, so the shares the leg covers ÷ the contracts traded is what one covered then.
      multiplier: leg.legType === "stock" ? 1 : (leg.quantity * leg.multiplier) / trade.quantity,
      price: trade.price,
      priceScale: priceScaleAt(symbol, trade.executedAt),
      commissionDollars: trade.commission,
      executedAt: trade.executedAt.toISOString(),
      tradingDate: easternIsoDate(trade.executedAt),
      isClosing: trade.isClosingTrade,
      actionId: trade.actionId,
    };
  });
}

/** "HOOD #12": a symbol's cycle as the screens name it. */
export function describeCycle(symbol: string, cycleNumber: number): string {
  return `${symbol} #${cycleNumber}`;
}

/**
 * One row per option sold, as traded on its opening day, with how it ended, its position's P&L and its wheel cycle
 * (the cycle of its symbol that was running when it was sold). `positions` and `cycles` are the session's own records.
 */
export function buildOptionTrades(ledger: SimulatedLedger, optionSales: readonly BacktestOptionSale[], actions: readonly BacktestAction[], positions: readonly BacktestPosition[], cycles: readonly BacktestCycle[]): SimulatedTrade[] {
  const actionById = new Map(actions.map((action) => [action.actionId, action]));
  const positionById = new Map(positions.map((position) => [position.positionId, position]));
  return optionSales.map((sale) => {
    const leg = requireLeg(ledger, sale.legId);
    const { actionId: _actionId, priceToCycleScale, ...asTraded } = sale;
    const position = positionById.get(leg.positionId) ?? null;
    const soldAtMs = leg.entryAt.getTime();
    const cycle = cycleRunningAt(cycles, sale.symbol, soldAtMs);
    const open: SimulatedTrade = {
      ...asTraded,
      endedBy: null,
      settledOn: null,
      settlementClose: null,
      inTheMoneyAtExpiry: null,
      pnlDollars: null,
      positionId: leg.positionId,
      positionStatus: position?.status ?? null,
      positionPnlDollars: position ? position.realizedPnlDollars + (position.unrealizedPnlDollars ?? 0) : null,
      cycleNumber: cycle?.cycleNumber ?? null,
      cycleLabel: cycle ? describeCycle(cycle.symbol, cycle.cycleNumber) : null,
      cycleStatus: cycle?.status ?? null,
      cycleTotalDollars: cycle?.totalDollars ?? null,
    };
    if (leg.exitAt === null || leg.exitPrice === null) return open;
    if (leg.settledAs !== null && leg.expiryClose !== null && leg.strikePrice !== null) {
      const assigned = leg.settledAs === "assigned";
      return { ...open, endedBy: assigned ? "assigned" : "expired_worthless", settledOn: leg.expiryDate, settlementClose: leg.expiryClose / priceToCycleScale, inTheMoneyAtExpiry: assigned };
    }
    const closingTrade = ledger.trades.find((trade) => trade.legId === leg.id && trade.isClosingTrade);
    const closedByRoll = closingTrade?.actionId !== null && closingTrade?.actionId !== undefined && actionById.get(closingTrade.actionId)?.kind === "roll";
    return { ...open, endedBy: closedByRoll ? "rolled" : "bought_back", settledOn: easternIsoDate(leg.exitAt) };
  });
}
