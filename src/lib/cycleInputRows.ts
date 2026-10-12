import { summarizeOpenCycle, type CycleOptionLeg as BreakEvenOptionLeg, type CycleStockTrade as BreakEvenStockTrade, type OpenCycleSummary, type OptionSettlementOutcome } from "./cycleBreakEven.js";
import type { CycleInput, CycleOptionLeg, CycleStockLeg, CycleStockTrade } from "./cycles.js";

// The rows the cycle loaders select (cycleQueries.ts, cycleBreakEvenQueries.ts) and their mapping into the inputs of
// deriveCycles and summarizeOpenCycle. Pure, so anything that holds the same rows (the backtest's simulated ledger)
// reaches the cycle engine through the same code as the database does.

/** One option leg with its closing-trade figures and the daily close of its expiry date. Timestamps as the driver returns them. */
export interface CycleOptionLegRow {
  id: string;
  positionId: string;
  tickerId: string;
  side: "long" | "short";
  optionType: "call" | "put";
  strike: number;
  quantity: number;
  multiplier: number;
  entryPrice: number;
  entryAt: Date | string;
  exitPrice: number | null;
  exitAt: Date | string | null;
  expiryDate: string;
  /** Sum of the commissions on the leg's closing trades (a missing commission counts as 0). */
  closingCommission: number;
  hasClosingTrade: boolean;
  /** Daily close on expiryDate, null when no bar exists. */
  expiryClose: number | null;
  /** positions.close_reason of the leg's position: selected by the break-even loader only. */
  positionCloseReason?: string | null;
  /** Never selected from the database; a simulated ledger states how each leg settled. */
  settledAs?: OptionSettlementOutcome;
}

export interface CycleStockLegRow {
  tickerId: string;
  positionId: string;
  quantity: number;
  entryAt: Date | string;
  exitAt: Date | string | null;
}

export interface CycleStockTradeRow {
  tickerId: string;
  at: Date | string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  commission: number;
}

export interface CycleDailyCloseRow {
  tickerId: string;
  /** YYYY-MM-DD. */
  date: string;
  close: number;
}

export interface CycleInputRows {
  optionRows: readonly CycleOptionLegRow[];
  stockLegRows: readonly CycleStockLegRow[];
  stockTradeRows: readonly CycleStockTradeRow[];
  /** Ascending by date: the last one of a ticker marks the shares it still holds. */
  barRows: readonly CycleDailyCloseRow[];
  /** Latest snapshot premium P&L of the open positions, by position id. */
  openPositionPremiumPnl: Map<string, number>;
}

function optionLegsOfTicker<Row extends CycleOptionLegRow>(rows: readonly Row[], tickerId: string) {
  return rows.filter((row) => row.tickerId === tickerId).map((row) => ({ ...row, entryAt: new Date(row.entryAt), exitAt: row.exitAt === null ? null : new Date(row.exitAt) }));
}

function stockTradesOfTicker(rows: readonly CycleStockTradeRow[], tickerId: string): CycleStockTrade[] {
  return rows.filter((row) => row.tickerId === tickerId).map((row) => ({ at: new Date(row.at), side: row.side, quantity: row.quantity, price: row.price, commission: row.commission }));
}

/** One ticker's CycleInput (deriveCycles) from the loader's rows of any number of tickers. */
export function buildCycleInputFromRows(tickerId: string, rows: CycleInputRows): CycleInput {
  const dailyCloses = new Map<string, number>();
  let lastPrice: { date: string; price: number } | null = null;
  for (const bar of rows.barRows.filter((row) => row.tickerId === tickerId)) {
    dailyCloses.set(bar.date, bar.close);
    lastPrice = { date: bar.date, price: bar.close };
  }
  const optionLegs: CycleOptionLeg[] = optionLegsOfTicker(rows.optionRows, tickerId);
  const stockLegs: CycleStockLeg[] = rows.stockLegRows
    .filter((row) => row.tickerId === tickerId)
    .map((row) => ({ positionId: row.positionId, quantity: row.quantity, entryAt: new Date(row.entryAt), exitAt: row.exitAt === null ? null : new Date(row.exitAt) }));
  return { optionLegs, stockLegs, stockTrades: stockTradesOfTicker(rows.stockTradeRows, tickerId), dailyCloses, lastPrice, openPositionPremiumPnl: rows.openPositionPremiumPnl };
}

export interface OpenCycleSummaryRows {
  /** The ticker's SHORT option legs, with positionCloseReason. */
  optionRows: readonly (CycleOptionLegRow & { positionCloseReason: string | null })[];
  stockTradeRows: readonly CycleStockTradeRow[];
  /** Shares in the ticker's open long stock legs. */
  openStockShares: number;
}

/** One ticker's open-cycle summary (summarizeOpenCycle) from the break-even loader's rows; null when the ticker is flat. */
export function summarizeOpenCycleFromRows(tickerId: string, rows: OpenCycleSummaryRows): OpenCycleSummary | null {
  const optionLegs: BreakEvenOptionLeg[] = optionLegsOfTicker(rows.optionRows, tickerId);
  const stockTrades: BreakEvenStockTrade[] = stockTradesOfTicker(rows.stockTradeRows, tickerId);
  return summarizeOpenCycle(optionLegs, stockTrades, rows.openStockShares);
}
