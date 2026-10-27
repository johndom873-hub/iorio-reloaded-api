import { db } from "../db/connection.js";
import { breakEvenByPositionFromHistory, type OpenCycleSummary, type PositionShareSourceLink } from "./cycleBreakEven.js";
import { assignmentDayCloseJoinSql, settlementCloseSelectSql, summarizeOpenCycleFromRows, type OpenCycleSummaryRows } from "./cycleInputRows.js";

export interface PositionBreakEven {
  breakEven: number | null;
  /** Why breakEven is null (shown as a tooltip), else null. */
  breakEvenUnavailableReason: string | null;
  cycleNetPremium: number | null;
  cycleSharesHeld: number | null;
  /** The symbol's consolidated cycle break-even (the Wheel cycle card's), and how many open positions share the cycle. */
  cycleBreakEven: number | null;
  cycleOpenPositionCount: number;
}

/** Each open position's own break-even (breakEvenByPositionFromHistory), from every option leg, stock fill and share hand-over of the positions' symbols. */
export async function fetchBreakEvenByPositionId(tickerIds: string[]): Promise<Map<string, PositionBreakEven>> {
  const result = new Map<string, PositionBreakEven>();
  const uniqueTickerIds = [...new Set(tickerIds)];
  if (uniqueTickerIds.length === 0) return result;
  const [summaries, openPositionRows, shareSourceRows] = await Promise.all([
    fetchOpenCycleSummaryByTickerId(uniqueTickerIds),
    // A hedge has no break-even, and its long leg stays out of the wheel's ledger.
    db.raw(
      `SELECT p.id, p.ticker_id AS "tickerId",
              COALESCE((SELECT SUM(pl.quantity) FROM position_legs pl WHERE pl.position_id = p.id AND pl.leg_type = 'stock' AND pl.side = 'long' AND pl.exit_at IS NULL), 0)::int AS "sharesHeld"
       FROM positions p WHERE p.status = 'open' AND p.strategy_key NOT IN ('hedge', 'leaps') AND p.ticker_id = ANY(?)`,
      [uniqueTickerIds],
    ),
    // Shares received: recorded with the link; a link from before that column, the receiving position's first stock leg as
    // created (with the shares later carved off it).
    db.raw(
      `SELECT pss.position_id AS "positionId", pss.source_position_id AS "sourcePositionId", p.ticker_id AS "tickerId",
              COALESCE(pss.shares_received,
                       (SELECT first_leg.quantity + COALESCE((SELECT SUM(slice.quantity) FROM position_legs slice WHERE slice.parent_leg_id = first_leg.id), 0)
                        FROM position_legs first_leg
                        WHERE first_leg.position_id = pss.position_id AND first_leg.leg_type = 'stock' AND first_leg.parent_leg_id IS NULL
                        ORDER BY first_leg.entry_at, first_leg.id LIMIT 1), 0)::int AS "sharesReceived"
       FROM position_share_sources pss JOIN positions p ON p.id = pss.position_id
       WHERE p.ticker_id = ANY(?)`,
      [uniqueTickerIds],
    ),
  ]);
  for (const [tickerId, summary] of summaries) {
    const openPositions = openPositionRows.rows
      .filter((row: { tickerId: string }) => row.tickerId === tickerId)
      .map((row: { id: string; sharesHeld: number }) => ({ positionId: row.id, sharesHeld: Number(row.sharesHeld) }));
    const shareSources: PositionShareSourceLink[] = shareSourceRows.rows
      .filter((row: { tickerId: string }) => row.tickerId === tickerId)
      .map((row: { positionId: string; sourcePositionId: string; sharesReceived: number }) => ({ positionId: row.positionId, sourcePositionId: row.sourcePositionId, sharesReceived: Number(row.sharesReceived) }));
    const breakEvenByPosition = breakEvenByPositionFromHistory(summary, openPositions, shareSources);
    for (const position of openPositions) {
      const { breakEven, reason } = breakEvenByPosition.get(position.positionId)!;
      result.set(position.positionId, {
        breakEven,
        breakEvenUnavailableReason: reason,
        cycleNetPremium: summary.netPremium,
        cycleSharesHeld: summary.sharesHeld,
        cycleBreakEven: summary.unavailableReason === null ? summary.breakEvenPerShare : null,
        cycleOpenPositionCount: openPositions.length,
      });
    }
  }
  return result;
}

/** The open cycle of each ticker (absent when the ticker is flat), from every short option leg and stock fill of the ticker. */
export async function fetchOpenCycleSummaryByTickerId(tickerIds: string[]): Promise<Map<string, OpenCycleSummary>> {
  const result = new Map<string, OpenCycleSummary>();
  for (const [tickerId, rows] of await fetchOpenCycleSummaryRowsByTickerId(tickerIds)) {
    const summary = summarizeOpenCycleFromRows(tickerId, rows);
    if (summary) result.set(tickerId, summary);
  }
  return result;
}

/** The rows fetchOpenCycleSummaryByTickerId summarizes, per ticker: for a caller that adds rows of its own first (the live ladder's look book). */
export async function fetchOpenCycleSummaryRowsByTickerId(tickerIds: string[]): Promise<Map<string, OpenCycleSummaryRows>> {
  const result = new Map<string, OpenCycleSummaryRows>();
  const uniqueTickerIds = [...new Set(tickerIds)];
  if (uniqueTickerIds.length === 0) return result;

  const [optionRows, stockTradeRows, openStockRows] = await Promise.all([
    db.raw(
      `SELECT pl.id, pl.position_id AS "positionId", p.ticker_id AS "tickerId", pl.side, pl.option_type AS "optionType",
              pl.strike_price::float AS strike, pl.quantity, pl.multiplier, pl.entry_price::float AS "entryPrice", pl.entry_at AS "entryAt",
              pl.exit_price::float AS "exitPrice", pl.exit_at AS "exitAt", pl.expiry_date::text AS "expiryDate",
              COALESCE((SELECT SUM(tr.commission) FROM trades tr WHERE tr.position_leg_id = pl.id AND tr.is_closing_trade), 0)::float AS "closingCommission",
              EXISTS (SELECT 1 FROM trades tr WHERE tr.position_leg_id = pl.id AND tr.is_closing_trade) AS "hasClosingTrade",
              ${settlementCloseSelectSql}, p.close_reason AS "positionCloseReason"
       FROM position_legs pl
       JOIN positions p ON p.id = pl.position_id
       LEFT JOIN daily_price_bars b ON b.ticker_id = p.ticker_id AND b.trading_date = pl.expiry_date
       ${assignmentDayCloseJoinSql}
       WHERE pl.leg_type = 'option' AND p.ticker_id = ANY(?)`,
      [uniqueTickerIds],
    ),
    db.raw(
      `SELECT p.ticker_id AS "tickerId", pl.position_id AS "positionId", tr.executed_at AS at, tr.side, tr.quantity, tr.price::float AS price, COALESCE(tr.commission, 0)::float AS commission
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
  ]);

  const openStockSharesByTicker = new Map<string, number>(openStockRows.rows.map((row: any) => [row.tickerId, Number(row.shares)]));
  for (const tickerId of uniqueTickerIds) {
    result.set(tickerId, {
      optionRows: optionRows.rows.filter((row: { tickerId: string }) => row.tickerId === tickerId),
      stockTradeRows: stockTradeRows.rows.filter((row: { tickerId: string }) => row.tickerId === tickerId),
      openStockShares: openStockSharesByTicker.get(tickerId) ?? 0,
    });
  }
  return result;
}
