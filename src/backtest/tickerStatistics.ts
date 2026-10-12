import type { BacktestCycle, BacktestPosition, BacktestTickerStatistics } from "./backtestTypes.js";

// Per-ticker figures of a session (docs/backtesting/FULL-FIDELITY-DESIGN.md §7.8), from its stored positions and wheel
// cycles, and the same over all its symbols together. Pure.
//
//   option sales          every short option leg: an opening put or call, the new leg of each roll
//   average traded DTE    mean calendar days to expiry of those legs when they were sold
//   put assigned share    put positions that ended assigned ÷ put positions that ended (assigned, expired, bought back, rolled)
//   realized P&L          Σ realized P&L of the ticker's positions
//   total P&L             Σ its cycles' totals: realized plus what is still held at the session's last marks
//   recovery sessions     closed cycles that had a put assigned: trading sessions from the assignment to the cycle's close;
//                         open cycles are listed apart with their age

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The label of the row that pools every symbol. */
export const allSymbolsStatisticsLabel = "All symbols";

function summarize(symbol: string, symbolPositions: readonly BacktestPosition[], symbolCycles: readonly BacktestCycle[]): BacktestTickerStatistics {
  const soldOptionLegs = symbolPositions.flatMap((position) => position.legs).filter((leg) => leg.legType === "option" && leg.side === "short" && leg.parentLegId === null);
  const tradedDtes = soldOptionLegs.map((leg) => leg.dteAtEntry).filter((dte): dte is number => dte !== null);
  const putPositions = symbolPositions.filter((position) => position.strategyKey === "cash_secured_put");
  const putPositionsEnded = putPositions.filter((position) => position.status === "closed");
  const putPositionsAssigned = putPositionsEnded.filter((position) => position.closeReason === "assigned");
  const closedCycles = symbolCycles.filter((cycle) => cycle.status === "closed");
  const openCycles = symbolCycles.filter((cycle) => cycle.status === "open");
  const recoveries = closedCycles.map((cycle) => cycle.recoverySessions).filter((sessions): sessions is number => sessions !== null);
  return {
    symbol,
    optionSaleCount: soldOptionLegs.length,
    averageTradedDte: mean(tradedDtes),
    putPositionCount: putPositions.length,
    putPositionsEnded: putPositionsEnded.length,
    putPositionsAssigned: putPositionsAssigned.length,
    putAssignedShare: putPositionsEnded.length === 0 ? null : putPositionsAssigned.length / putPositionsEnded.length,
    realizedPnlDollars: symbolPositions.reduce((sum, position) => sum + position.realizedPnlDollars, 0),
    totalPnlDollars: symbolCycles.reduce((sum, cycle) => sum + cycle.totalDollars, 0),
    closedCycleCount: closedCycles.length,
    openCycleCount: openCycles.length,
    recoverySessions: { count: recoveries.length, mean: mean(recoveries), median: median(recoveries), longest: recoveries.length === 0 ? null : Math.max(...recoveries) },
    openCycles: openCycles.map((cycle) => ({ symbol: cycle.symbol, cycleNumber: cycle.cycleNumber, openedOn: cycle.openedOn, assignedOn: cycle.assignedOn, ageSessions: cycle.ageSessions, totalDollars: cycle.totalDollars, sharesHeld: cycle.sharesHeld })),
  };
}

/** One row per symbol, in alphabetical order. */
export function computeTickerStatistics(positions: readonly BacktestPosition[], cycles: readonly BacktestCycle[]): BacktestTickerStatistics[] {
  const symbols = [...new Set([...positions.map((position) => position.symbol), ...cycles.map((cycle) => cycle.symbol)])].sort();
  return symbols.map((symbol) => summarize(symbol, positions.filter((position) => position.symbol === symbol), cycles.filter((cycle) => cycle.symbol === symbol)));
}

/**
 * The same figures over every symbol together: counts and dollars add up, the averages are over all the options sold
 * and all the cycles (so a symbol weighs by how much it traded). Null when there is nothing to summarize.
 */
export function computeAllSymbolsStatistics(positions: readonly BacktestPosition[], cycles: readonly BacktestCycle[]): BacktestTickerStatistics | null {
  return positions.length === 0 && cycles.length === 0 ? null : summarize(allSymbolsStatisticsLabel, positions, cycles);
}
