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
  /** IBKR assigned the leg before its expiry date (assignedBeforeExpirySql): it settles as assigned, on that day's close. */
  assignedBeforeExpiry?: boolean;
  /** The timeline's figures from the leg's fills: selected by the cycle loader only (see CycleOptionLeg). */
  openingFillPrice?: number | null;
  openingFillCount?: number;
  openingCommission?: number | null;
  closingFillPrice?: number | null;
  /** The timeline's label for the leg's opening or closing row in place of the fill's: a simulated book's bookkeeping moves name themselves. Never selected. */
  openingRowLabel?: string;
  closingRowLabel?: string;
}

// An early assignment settles the cycle on the assignment date (Marcelo 2026-10-15): a short leg that left before its
// expiry date with no closing trade, on a position reconciliation marked assigned, is assigned then, priced at the close
// of the last session that ended before the leg closed, not at its expiry date's close (no bar exists until then, which
// left the break-even blank for up to 45 days). The loaders' SQL, with pl = position_legs and p = positions:
export const assignedBeforeExpirySql = `(p.close_reason = 'assigned' AND pl.side = 'short' AND pl.exit_at IS NOT NULL
  AND (pl.exit_at AT TIME ZONE 'America/New_York')::date < pl.expiry_date
  AND NOT EXISTS (SELECT 1 FROM trades tr WHERE tr.position_leg_id = pl.id AND tr.is_closing_trade))`;
/** Joins `settlement_bar`: the close of the last session that ended before an early-assigned leg closed (none otherwise). */
export const assignmentDayCloseJoinSql = `LEFT JOIN LATERAL (
  SELECT ab.close_price FROM daily_price_bars ab
  WHERE ${assignedBeforeExpirySql} AND ab.ticker_id = p.ticker_id
    AND ab.trading_date <= (pl.exit_at AT TIME ZONE 'America/New_York')::date
    AND ((ab.trading_date + time '16:00') AT TIME ZONE 'America/New_York') <= pl.exit_at
  ORDER BY ab.trading_date DESC LIMIT 1) settlement_bar ON true`;
/** The settlement close the cycle engines read as expiryClose, and the early-assignment flag. */
export const settlementCloseSelectSql = `(CASE WHEN ${assignedBeforeExpirySql} THEN settlement_bar.close_price ELSE b.close_price END)::float AS "expiryClose", ${assignedBeforeExpirySql} AS "assignedBeforeExpiry"`;

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
  /** The position whose stock leg holds the fill: selected by the break-even loader only. */
  positionId?: string;
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
  /** The snapshot date of each openPositionPremiumPnl mark, by position id. */
  openPositionMarkDate?: Map<string, string>;
  /** What the shares behind each Covered Call position were bought at (stockLegAcquisitionFills.ts). */
  stockCostPriceByPositionId?: Map<string, number>;
}

function optionLegsOfTicker<Row extends CycleOptionLegRow>(rows: readonly Row[], tickerId: string) {
  return rows
    .filter((row) => row.tickerId === tickerId)
    .map(({ assignedBeforeExpiry, ...row }) => ({ ...row, entryAt: new Date(row.entryAt), exitAt: row.exitAt === null ? null : new Date(row.exitAt), ...(assignedBeforeExpiry && row.settledAs === undefined ? { settledAs: "assigned" as const } : {}) }));
}

function stockTradesOfTicker(rows: readonly CycleStockTradeRow[], tickerId: string): CycleStockTrade[] {
  return rows
    .filter((row) => row.tickerId === tickerId)
    .map((row) => ({ at: new Date(row.at), side: row.side, quantity: row.quantity, price: row.price, commission: row.commission, ...(row.positionId === undefined ? {} : { positionId: row.positionId }) }));
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
  return {
    optionLegs,
    stockLegs,
    stockTrades: stockTradesOfTicker(rows.stockTradeRows, tickerId),
    dailyCloses,
    lastPrice,
    openPositionPremiumPnl: rows.openPositionPremiumPnl,
    openPositionMarkDate: rows.openPositionMarkDate,
    ...(rows.stockCostPriceByPositionId === undefined ? {} : { stockCostPriceByPositionId: rows.stockCostPriceByPositionId }),
  };
}

export interface OpenCycleSummaryRows {
  /** The ticker's option legs (long ones only bound the cycle; see summarizeOpenCycle), with positionCloseReason. */
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
