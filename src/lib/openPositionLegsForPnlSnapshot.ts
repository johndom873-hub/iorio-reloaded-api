import { db } from "../db/connection.js";

/** A leg the nightly P&L snapshot (scripts/run-daily-pnl-snapshot-job.ts) values and fetches greeks for. */
export interface OpenPositionLegRow {
  positionId: string;
  legId: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  optionType: "call" | "put" | null;
  strikePrice: string | null;
  /** YYYYMMDD, null for a stock leg. */
  expiryDate: string | null;
  multiplier: number;
  entryPrice: string;
  symbol: string;
}

/**
 * The legs still open (exit_at IS NULL) of every open position. A partial close carves the closed quantity into its own
 * closed leg that stays on the open position (partialCloseSlice.ts); its P&L is realized, counted from that closed leg,
 * so valuing it again as unrealized would count it twice.
 */
export async function fetchOpenLegsOfOpenPositions(): Promise<OpenPositionLegRow[]> {
  const result = await db.raw(
    `
    SELECT
      p.id AS "positionId",
      pl.id AS "legId",
      pl.leg_type AS "legType",
      pl.side,
      pl.quantity,
      pl.option_type AS "optionType",
      pl.strike_price AS "strikePrice",
      to_char(pl.expiry_date, 'YYYYMMDD') AS "expiryDate",
      pl.multiplier,
      pl.entry_price AS "entryPrice",
      t.symbol
    FROM positions p
    JOIN position_legs pl ON pl.position_id = p.id
    JOIN tickers t ON t.id = p.ticker_id
    WHERE p.status = 'open' AND pl.exit_at IS NULL
    `,
  );
  return result.rows;
}
