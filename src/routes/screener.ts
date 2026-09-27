import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { findOrCreateTicker, addTickerToShortlist, UnknownSymbolError } from "../ibkr/findOrCreateTicker.js";

export const screenerRouter = Router();
screenerRouter.use(requireAuth);

const unmatchedRankSentinel = 999;
const bestRankBuckets: Record<string, { min: number; max: number }> = {
  "1-10": { min: 1, max: 10 },
  "11-20": { min: 11, max: 20 },
  "21-30": { min: 21, max: 30 },
  "31-40": { min: 31, max: 40 },
  "41-50": { min: 41, max: 50 },
};

interface ScreenerFilters {
  search?: string;
  sector?: string;
  minIv?: number;
  bestRankBucket?: string;
}

function parseFilters(query: Record<string, unknown>): ScreenerFilters {
  const str = (key: string): string | undefined => (typeof query[key] === "string" && (query[key] as string).trim() ? (query[key] as string).trim() : undefined);
  const minIvRaw = str("minIv");
  const minIv = minIvRaw !== undefined ? Number(minIvRaw) : undefined;
  return {
    search: str("search"),
    sector: str("sector"),
    minIv: minIv !== undefined && Number.isFinite(minIv) ? minIv : undefined,
    bestRankBucket: str("bestRankBucket"),
  };
}

// Reads the accumulated screener_universe (job:daily-screener-scan) — never
// calls IBKR live, so filter changes are instant. isShortlisted is a
// per-row EXISTS check by symbol (no FK to `tickers` — see the migration
// comment for why) so the UI can hide/disable "Add to Shortlist" for
// candidates already being monitored. IBKR ranks are 0-indexed; the API
// keeps that convention and the frontend displays rank + 1.
screenerRouter.get("/", async (request, response) => {
  const filters = parseFilters(request.query as Record<string, unknown>);

  const query = db("screener_universe as su").select(
    "su.*",
    db.raw(`
      EXISTS (
        SELECT 1 FROM tickers t
        JOIN shortlist_entries se ON se.ticker_id = t.id AND se.removed_at IS NULL
        WHERE t.symbol = su.symbol
      ) AS "isShortlisted"
    `),
  );

  if (filters.search !== undefined) {
    const like = `%${filters.search.replace(/[%_]/g, (char) => `\\${char}`)}%`;
    query.where((builder) => builder.whereILike("su.symbol", like).orWhereILike("su.company_name", like));
  }
  if (filters.sector !== undefined) query.where("su.sector", filters.sector);
  if (filters.minIv !== undefined) query.where("su.implied_volatility", ">=", filters.minIv);
  if (filters.bestRankBucket !== undefined) {
    if (filters.bestRankBucket === "unmatched") {
      query.where("su.best_rank", unmatchedRankSentinel);
    } else {
      const bucket = bestRankBuckets[filters.bestRankBucket];
      // IBKR's 0-indexed rank stored as-is — a "1-10" bucket (1-indexed, as
      // shown to the user) covers stored ranks 0-9.
      if (bucket) query.whereBetween("su.best_rank", [bucket.min - 1, bucket.max - 1]);
    }
  }

  const rows = await query.orderBy("su.best_rank", "asc");

  response.json(
    rows.map((row) => ({
      id: row.id,
      symbol: row.symbol,
      companyName: row.company_name,
      sector: row.sector,
      bestRank: row.best_rank,
      matchedScanCodes: row.matched_scan_codes,
      avgShareVolume: row.avg_share_volume,
      avgOptionVolume: row.avg_option_volume,
      callOpenInterest: row.call_open_interest,
      putOpenInterest: row.put_open_interest,
      bidAskSpreadPct: row.bid_ask_spread_pct,
      impliedVolatility: row.implied_volatility,
      firstSeenAt: row.first_seen_at,
      lastMatchedAt: row.last_matched_at,
      lastRefreshedAt: row.last_refreshed_at,
      isShortlisted: row.isShortlisted,
    })),
  );
});

// Distinct sectors across the whole accumulated universe — independent of
// the current filter selection, so the dropdown doesn't shrink to whatever
// sectors happen to survive the active filters (self-referential bug fixed
// 2026-09-09 on the old table; same rule applies here).
screenerRouter.get("/sectors", async (_request, response) => {
  const rows = await db("screener_universe")
    .distinct("sector")
    .whereNotNull("sector")
    .orderBy("sector", "asc");

  response.json(rows.map((row) => row.sector as string));
});

// Adds a scan candidate to the shortlist — same idempotent find-or-create +
// shortlist-insert path the Shortlist tab's manual "+ Add Ticker" uses
// (shortlist.ts), reused here rather than duplicated.
screenerRouter.post("/:symbol/shortlist", async (request, response) => {
  const symbol = request.params.symbol.trim().toUpperCase();
  const { notes } = request.body as { notes?: string };

  const candidate = await db("screener_universe").where({ symbol }).first();
  if (!candidate) {
    response.status(404).json({ error: `${symbol} is not a current screener candidate.` });
    return;
  }

  let ticker: Awaited<ReturnType<typeof findOrCreateTicker>>["ticker"];
  try {
    ({ ticker } = await findOrCreateTicker(symbol));
  } catch (error) {
    if (error instanceof UnknownSymbolError) {
      response.status(422).json({ error: error.message });
      return;
    }
    throw error;
  }

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
