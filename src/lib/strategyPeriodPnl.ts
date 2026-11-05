import type { BookKey } from "../books/bookKeys.js";
import { bookOfPositionAtNightSql } from "../books/bookDashboard.js";
import { db } from "../db/connection.js";
import { legRealizedPnlSql } from "./legRealizedPnlSql.js";

// The Dashboard's per-strategy Day/WTD/MTD/YTD table and YTD card moved to the fair cycle attribution
// (cyclePeriodPnl.ts, 2026-09-21). What remains here is the daily series behind the P&L Over Time chart, still on
// the older per-position strategy_key attribution.
//
// Daily per-strategy P&L series for the multi-series chart (formula approved by Marcelo 2026-11-02). Per position, a day's
// P&L is the change in its total P&L since its previous point, counted from 0 before its first:
//   total P&L(d) = realized P&L of its legs closed on or before d + its unrealized snapshot of d   (a snapshot date)
//   total P&L(d) = its lifetime realized P&L                                                      (the day it closed)
// The points are a position's snapshot dates and the day it closed, so over its life the days add up to exactly its P&L:
// the opening day counts (from entry to that close), and a partial close's realized P&L is not netted against the whole
// position's unrealized. A close is dated by its trading session, like the snapshots (lastCompletedSessionDate): the latest open
// market_calendar day whose 09:30 ET open came at or before it, so Friday's expiries that IBKR settles after midnight land on
// Friday (Marcelo 2026-11-02); without a calendar day in the ten days before it, its New York date. A day/strategy cell with
// no activity and no open position that day is legitimately 0, not missing.
//
// Shares handed from one position to another (position_share_sources; Marcelo 2026-11-02) move at their market value, not
// at cost: the position handing them over is credited with value = (close of the hand-over's trading session − the cost they
// are handed at) × shares received, and the receiving position counts from −value. The cost is the source's handed-over
// stock legs' exit price (the carried cost) or, for an assigned cash-secured put, its strike. Each value is added to the
// source's total and taken from the receiver's from the moment of the hand-over (snapshots captured after it, and their
// closes), so the account total is unchanged and a day's price move shows on the position that held the shares that day.
// Without a close or a share count for the link the value is 0, as before this rule.
export interface StrategyDailyPnl {
  snapshotDate: string;
  strategyKey: string;
  dailyPnl: number;
}

/** SQL for the trading session a timestamptz belongs to (see the header). */
function sessionDateSql(timestamp: string): string {
  const newYorkDate = `(${timestamp} AT TIME ZONE 'America/New_York')::date`;
  return `COALESCE((SELECT MAX(mc.calendar_date) FROM market_calendar mc
    WHERE mc.is_open AND mc.calendar_date BETWEEN ${newYorkDate} - 10 AND ${newYorkDate}
      AND (mc.calendar_date + time '09:30') AT TIME ZONE 'America/New_York' <= ${timestamp}), ${newYorkDate})`;
}

/**
 * `book` (the Dashboard's book switch, Marcelo 2026-11-05): only each position's daily P&L in the book its ticker belonged
 * to that night (bookOfPositionAtNightSql), and only from the books' first date (`booksFromDate`); null = every position.
 */
export async function computeStrategyDailyPnlSeries(days: number, book: { book: BookKey; booksFromDate: string } | null = null): Promise<StrategyDailyPnl[]> {
  const bookFilter = book === null ? "" : `WHERE ${bookOfPositionAtNightSql("p", "pd.d")} = ? AND pd.d >= ?::date`;
  const result = await db.raw(
    `
    WITH days AS (
      SELECT generate_series((CURRENT_DATE - (? - 1)::int), CURRENT_DATE, interval '1 day')::date AS d
    ),
    strategies AS (
      SELECT DISTINCT strategy_key FROM positions
    ),
    leg_realized AS (
      SELECT pl.position_id, ${sessionDateSql("pl.exit_at")} AS exit_date, ${legRealizedPnlSql("pl")} AS realized
      FROM position_legs pl
      WHERE pl.exit_price IS NOT NULL
    ),
    closed_positions AS (
      SELECT lr.position_id, MAX(lr.exit_date) AS close_date, SUM(lr.realized) AS lifetime_realized
      FROM leg_realized lr
      JOIN positions p ON p.id = lr.position_id
      WHERE p.status = 'closed'
      GROUP BY lr.position_id
    ),
    hand_overs AS (
      SELECT pss.position_id AS receiver_id, pss.source_position_id AS source_id, pss.created_at AS handed_at,
        COALESCE((mark.close_price - handed_cost.cost_per_share) * pss.shares_received, 0) AS handed_value
      FROM position_share_sources pss
      JOIN positions source ON source.id = pss.source_position_id
      LEFT JOIN LATERAL (
        SELECT b.close_price FROM daily_price_bars b
        WHERE b.ticker_id = source.ticker_id AND b.close_price IS NOT NULL AND b.trading_date <= ${sessionDateSql("pss.created_at")}
        ORDER BY b.trading_date DESC LIMIT 1
      ) mark ON true
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN source.strategy_key = 'cash_secured_put' THEN
            (SELECT MAX(put_leg.strike_price) FROM position_legs put_leg WHERE put_leg.position_id = source.id AND put_leg.leg_type = 'option' AND put_leg.option_type = 'put' AND put_leg.side = 'short')
          ELSE
            (SELECT SUM(stock_leg.quantity * stock_leg.exit_price) / NULLIF(SUM(stock_leg.quantity), 0) FROM position_legs stock_leg
             WHERE stock_leg.position_id = source.id AND stock_leg.leg_type = 'stock' AND stock_leg.exit_price IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM trades tr WHERE tr.position_leg_id = stock_leg.id AND tr.is_closing_trade))
        END AS cost_per_share
      ) handed_cost ON true
    ),
    points AS (
      SELECT s.position_id, s.snapshot_date AS d,
        s.unrealized_pnl + COALESCE((SELECT SUM(lr.realized) FROM leg_realized lr WHERE lr.position_id = s.position_id AND lr.exit_date <= s.snapshot_date), 0)
          + COALESCE((SELECT SUM(h.handed_value) FROM hand_overs h WHERE h.source_id = s.position_id AND h.handed_at < s.captured_at), 0)
          - COALESCE((SELECT SUM(h.handed_value) FROM hand_overs h WHERE h.receiver_id = s.position_id AND h.handed_at < s.captured_at), 0) AS total_pnl
      FROM position_pnl_snapshots s
      LEFT JOIN closed_positions cp ON cp.position_id = s.position_id
      WHERE cp.close_date IS NULL OR s.snapshot_date < cp.close_date
      UNION ALL
      SELECT cp.position_id, cp.close_date, cp.lifetime_realized
          + COALESCE((SELECT SUM(h.handed_value) FROM hand_overs h WHERE h.source_id = cp.position_id), 0)
          - COALESCE((SELECT SUM(h.handed_value) FROM hand_overs h WHERE h.receiver_id = cp.position_id), 0)
      FROM closed_positions cp
    ),
    position_daily AS (
      SELECT position_id, d, total_pnl - COALESCE(LAG(total_pnl) OVER (PARTITION BY position_id ORDER BY d), 0) AS daily_pnl
      FROM points
    ),
    strategy_daily AS (
      SELECT p.strategy_key, pd.d, SUM(pd.daily_pnl) AS daily_pnl
      FROM position_daily pd
      JOIN positions p ON p.id = pd.position_id
      ${bookFilter}
      GROUP BY p.strategy_key, pd.d
    )
    SELECT
      days.d AS "snapshotDate",
      strategies.strategy_key AS "strategyKey",
      COALESCE(sd.daily_pnl, 0) AS "dailyPnl"
    FROM days
    CROSS JOIN strategies
    LEFT JOIN strategy_daily sd ON sd.strategy_key = strategies.strategy_key AND sd.d = days.d
    ORDER BY days.d, strategies.strategy_key
    `,
    book === null ? [days] : [days, book.book, book.booksFromDate],
  );

  return result.rows.map((row: Record<string, string>) => ({
    snapshotDate: row.snapshotDate,
    strategyKey: row.strategyKey,
    dailyPnl: Number(row.dailyPnl),
  }));
}
