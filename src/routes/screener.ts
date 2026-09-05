import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { findOrCreateTicker, addTickerToShortlist } from "../ibkr/findOrCreateTicker.js";

export const screenerRouter = Router();
screenerRouter.use(requireAuth);

interface ScreenerFilters {
  maxPrice?: number;
  minIvRatio?: number;
  maxIvRatio?: number;
  minAvgOptionVolume?: number;
  minAvgShareVolume?: number;
  maxBidAskSpreadPct?: number;
  sector?: string;
}

function parseFilters(query: Record<string, unknown>): ScreenerFilters {
  const num = (key: string): number | undefined => {
    const raw = query[key];
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  return {
    maxPrice: num("maxPrice"),
    minIvRatio: num("minIvRatio"),
    maxIvRatio: num("maxIvRatio"),
    minAvgOptionVolume: num("minAvgOptionVolume"),
    minAvgShareVolume: num("minAvgShareVolume"),
    maxBidAskSpreadPct: num("maxBidAskSpreadPct"),
    sector: typeof query.sector === "string" && query.sector.trim() ? query.sector.trim() : undefined,
  };
}

// Reads the latest cached daily scan (job:daily-screener-scan) — never
// calls IBKR live, so filter changes are instant. isShortlisted is a
// per-row EXISTS check by symbol (screener_scan_results has no FK to
// `tickers` — see the migration comment for why) so the UI can hide/disable
// "Add to Shortlist" for candidates already being monitored.
screenerRouter.get("/", async (request, response) => {
  const filters = parseFilters(request.query as Record<string, unknown>);

  const query = db("screener_scan_results as ssr").select(
    "ssr.*",
    db.raw(`
      EXISTS (
        SELECT 1 FROM tickers t
        JOIN shortlist_entries se ON se.ticker_id = t.id AND se.removed_at IS NULL
        WHERE t.symbol = ssr.symbol
      ) AS "isShortlisted"
    `),
  );

  if (filters.maxPrice !== undefined) query.where("ssr.last_price", "<=", filters.maxPrice);
  if (filters.minIvRatio !== undefined) query.where("ssr.iv_vs_hist_ratio", ">=", filters.minIvRatio);
  if (filters.maxIvRatio !== undefined) query.where("ssr.iv_vs_hist_ratio", "<=", filters.maxIvRatio);
  if (filters.minAvgOptionVolume !== undefined) query.where("ssr.avg_option_volume", ">=", filters.minAvgOptionVolume);
  if (filters.minAvgShareVolume !== undefined) query.where("ssr.avg_share_volume", ">=", filters.minAvgShareVolume);
  if (filters.maxBidAskSpreadPct !== undefined) query.where("ssr.bid_ask_spread_pct", "<=", filters.maxBidAskSpreadPct);
  if (filters.sector !== undefined) query.where("ssr.sector", filters.sector);

  const rows = await query.orderBy("ssr.best_rank", "asc");

  response.json(
    rows.map((row) => ({
      id: row.id,
      symbol: row.symbol,
      companyName: row.company_name,
      sector: row.sector,
      scanCodes: row.scan_codes,
      bestRank: row.best_rank,
      lastPrice: row.last_price,
      avgShareVolume: row.avg_share_volume,
      avgOptionVolume: row.avg_option_volume,
      callOpenInterest: row.call_open_interest,
      putOpenInterest: row.put_open_interest,
      bidAskSpreadPct: row.bid_ask_spread_pct,
      ivVsHistRatio: row.iv_vs_hist_ratio,
      impliedVolatility: row.implied_volatility,
      scanDate: row.scan_date,
      firstSeenDate: row.first_seen_date,
      isShortlisted: row.isShortlisted,
    })),
  );
});

// Adds a scan candidate to the shortlist — same idempotent find-or-create +
// shortlist-insert path the Shortlist tab's manual "+ Add Ticker" uses
// (shortlist.ts), reused here rather than duplicated.
screenerRouter.post("/:symbol/shortlist", async (request, response) => {
  const symbol = request.params.symbol.trim().toUpperCase();
  const { notes } = request.body as { notes?: string };

  const candidate = await db("screener_scan_results").where({ symbol }).first();
  if (!candidate) {
    response.status(404).json({ error: `${symbol} is not a current screener candidate.` });
    return;
  }

  const { ticker } = await findOrCreateTicker(symbol);

  try {
    await addTickerToShortlist(ticker.id, ticker.symbol, request.session.userId, notes);
    response.status(204).end();
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      response.status(409).json({ error: `${symbol} is already being monitored.` });
      return;
    }
    throw error;
  }
});
