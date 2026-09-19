import { db } from "../db/connection.js";
import { breakEvenForPosition, summarizeOpenCycle, type CycleOptionLeg, type CycleStockTrade } from "./cycleBreakEven.js";

export interface PositionBreakEven {
  breakEven: number | null;
  /** Why breakEven is null (shown as a tooltip), else null. */
  breakEvenUnavailableReason: string | null;
  cycleNetPremium: number | null;
  cycleSharesHeld: number | null;
}

/** Break-even per open position id, derived from every option leg and stock fill of the positions' symbols. */
export async function fetchBreakEvenByPositionId(tickerIds: string[]): Promise<Map<string, PositionBreakEven>> {
  const result = new Map<string, PositionBreakEven>();
  const uniqueTickerIds = [...new Set(tickerIds)];
  if (uniqueTickerIds.length === 0) return result;

  const [optionRows, stockTradeRows, openStockRows, openPositionRows] = await Promise.all([
    db.raw(
      `SELECT pl.id, pl.position_id AS "positionId", p.ticker_id AS "tickerId", pl.side, pl.option_type AS "optionType",
              pl.strike_price::float AS strike, pl.quantity, pl.multiplier, pl.entry_price::float AS "entryPrice", pl.entry_at AS "entryAt",
              pl.exit_price::float AS "exitPrice", pl.exit_at AS "exitAt", pl.expiry_date::text AS "expiryDate",
              COALESCE((SELECT SUM(tr.commission) FROM trades tr WHERE tr.position_leg_id = pl.id AND tr.is_closing_trade), 0)::float AS "closingCommission",
              EXISTS (SELECT 1 FROM trades tr WHERE tr.position_leg_id = pl.id AND tr.is_closing_trade) AS "hasClosingTrade",
              b.close_price::float AS "expiryClose"
       FROM position_legs pl
       JOIN positions p ON p.id = pl.position_id
       LEFT JOIN daily_price_bars b ON b.ticker_id = p.ticker_id AND b.trading_date = pl.expiry_date
       WHERE pl.leg_type = 'option' AND p.ticker_id = ANY(?)`,
      [uniqueTickerIds],
    ),
    db.raw(
      `SELECT p.ticker_id AS "tickerId", tr.executed_at AS at, tr.side, tr.quantity, tr.price::float AS price, COALESCE(tr.commission, 0)::float AS commission
       FROM trades tr
       JOIN position_legs pl ON pl.id = tr.position_leg_id
       JOIN positions p ON p.id = pl.position_id
       WHERE pl.leg_type = 'stock' AND p.ticker_id = ANY(?)`,
      [uniqueTickerIds],
    ),
    db.raw(
      `SELECT p.ticker_id AS "tickerId", SUM(pl.quantity)::int AS shares
       FROM position_legs pl JOIN positions p ON p.id = pl.position_id
       WHERE pl.leg_type = 'stock' AND pl.side = 'long' AND pl.exit_at IS NULL AND p.ticker_id = ANY(?)
       GROUP BY p.ticker_id`,
      [uniqueTickerIds],
    ),
    db.raw(`SELECT p.id, p.ticker_id AS "tickerId" FROM positions p WHERE p.status = 'open' AND p.ticker_id = ANY(?)`, [uniqueTickerIds]),
  ]);

  const openStockSharesByTicker = new Map<string, number>(openStockRows.rows.map((row: any) => [row.tickerId, Number(row.shares)]));
  for (const tickerId of uniqueTickerIds) {
    const optionLegs: CycleOptionLeg[] = optionRows.rows
      .filter((row: any) => row.tickerId === tickerId)
      .map((row: any) => ({ ...row, entryAt: new Date(row.entryAt), exitAt: row.exitAt === null ? null : new Date(row.exitAt) }));
    const stockTrades: CycleStockTrade[] = stockTradeRows.rows
      .filter((row: any) => row.tickerId === tickerId)
      .map((row: any) => ({ at: new Date(row.at), side: row.side, quantity: row.quantity, price: row.price, commission: row.commission }));
    const summary = summarizeOpenCycle(optionLegs, stockTrades, openStockSharesByTicker.get(tickerId) ?? 0);
    if (!summary) continue;
    for (const position of openPositionRows.rows.filter((row: any) => row.tickerId === tickerId)) {
      const { breakEven, reason } = breakEvenForPosition(summary, position.id);
      result.set(position.id, { breakEven, breakEvenUnavailableReason: reason, cycleNetPremium: summary.netPremium, cycleSharesHeld: summary.sharesHeld });
    }
  }
  return result;
}
