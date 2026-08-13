import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const screenerRouter = Router();
screenerRouter.use(requireAuth);

// One row per watchlist ticker, carrying its latest market_data_snapshots
// row if one exists (LEFT JOIN LATERAL, not a plain join) — new tickers with
// no captured data yet still show up, just with null IV/volume, and fill in
// once the daily capture job (scripts/capture-screener-snapshot.ts) runs.
screenerRouter.get("/", async (_request, response) => {
  const result = await db.raw(`
    SELECT
      t.id AS "tickerId",
      t.symbol,
      t.company_name AS "companyName",
      t.sector,
      m.snapshot_date AS "snapshotDate",
      m.implied_volatility AS "impliedVolatility",
      m.avg_option_volume AS "avgOptionVolume",
      m.captured_at AS "capturedAt"
    FROM tickers t
    LEFT JOIN LATERAL (
      SELECT *
      FROM market_data_snapshots
      WHERE ticker_id = t.id
      ORDER BY snapshot_date DESC
      LIMIT 1
    ) m ON true
    ORDER BY t.symbol
  `);

  response.json(result.rows);
});
