import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchNewTickerData } from "../ibkr/fetchNewTickerData.js";
import { searchTickers } from "../ibkr/searchTickers.js";

export const screenerRouter = Router();
screenerRouter.use(requireAuth);

// v1 strategy scope — see PROGRESS.md "Decisions made".
const validStrategyKeys = ["covered_call", "cash_secured_put"];

// Live IBKR search-as-you-type — matches symbol or company name, US-listed
// optionable stocks only. Registered before "/" so it doesn't collide with
// the strategy-list route.
screenerRouter.get("/search", async (request, response) => {
  const query = (request.query.q as string | undefined)?.trim();
  if (!query || query.length < 1) {
    response.json([]);
    return;
  }

  const results = await searchTickers(query);
  response.json(results);
});

// One row per ticker currently monitored under this strategy, carrying its
// latest market_data_snapshots row if one exists (LEFT JOIN LATERAL, not a
// plain join) — a just-added ticker with no capture yet still shows up,
// just with null IV/volume, filling in once the daily capture job runs.
screenerRouter.get("/", async (request, response) => {
  const strategyKey = request.query.strategy as string | undefined;
  if (!strategyKey || !validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "A valid strategy query parameter is required." });
    return;
  }

  const result = await db.raw(
    `
    SELECT
      se.id,
      se.strategy_key AS "strategyKey",
      se.added_at AS "addedAt",
      se.notes,
      t.id AS "tickerId",
      t.symbol,
      t.company_name AS "companyName",
      t.sector,
      m.snapshot_date AS "snapshotDate",
      m.implied_volatility AS "impliedVolatility",
      m.avg_option_volume AS "avgOptionVolume",
      m.captured_at AS "capturedAt"
    FROM shortlist_entries se
    JOIN tickers t ON t.id = se.ticker_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM market_data_snapshots
      WHERE ticker_id = t.id
      ORDER BY snapshot_date DESC
      LIMIT 1
    ) m ON true
    WHERE se.strategy_key = ? AND se.removed_at IS NULL
    ORDER BY t.symbol
    `,
    [strategyKey],
  );

  response.json(result.rows);
});

screenerRouter.post("/", async (request, response) => {
  const { symbol, strategyKey, notes } = request.body as {
    symbol?: string;
    strategyKey?: string;
    notes?: string;
  };

  if (!symbol || !symbol.trim()) {
    response.status(400).json({ error: "Symbol is required." });
    return;
  }
  if (!strategyKey || !validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "A valid strategyKey is required." });
    return;
  }

  const normalizedSymbol = symbol.trim().toUpperCase();

  let ticker = await db("tickers").where({ symbol: normalizedSymbol }).first();
  if (!ticker) {
    const tickerData = await fetchNewTickerData(normalizedSymbol);
    [ticker] = await db("tickers")
      .insert({ symbol: normalizedSymbol, company_name: tickerData.companyName, sector: tickerData.sector })
      .returning("*");

    await db("market_data_snapshots")
      .insert({
        ticker_id: ticker.id,
        snapshot_date: new Date().toISOString().slice(0, 10),
        implied_volatility: tickerData.impliedVolatility,
        avg_option_volume: tickerData.avgOptionVolume,
      })
      .onConflict(["ticker_id", "snapshot_date"])
      .merge();
  }

  const latestSnapshot = await db("market_data_snapshots")
    .where({ ticker_id: ticker.id })
    .orderBy("snapshot_date", "desc")
    .first();

  try {
    const [entry] = await db("shortlist_entries")
      .insert({
        ticker_id: ticker.id,
        strategy_key: strategyKey,
        added_by_user_id: request.session.userId,
        notes: notes ?? null,
      })
      .returning("*");

    response.status(201).json({
      id: entry.id,
      strategyKey: entry.strategy_key,
      addedAt: entry.added_at,
      notes: entry.notes,
      tickerId: ticker.id,
      symbol: ticker.symbol,
      companyName: ticker.company_name,
      sector: ticker.sector,
      snapshotDate: latestSnapshot?.snapshot_date ?? null,
      impliedVolatility: latestSnapshot?.implied_volatility ?? null,
      avgOptionVolume: latestSnapshot?.avg_option_volume ?? null,
      capturedAt: latestSnapshot?.captured_at ?? null,
    });
  } catch (error) {
    // Partial unique index on (ticker_id, strategy_key) WHERE removed_at IS NULL.
    if ((error as { code?: string }).code === "23505") {
      response.status(409).json({ error: `${normalizedSymbol} is already being monitored for this strategy.` });
      return;
    }
    throw error;
  }
});

screenerRouter.patch("/:id", async (request, response) => {
  const { notes } = request.body as { notes?: string | null };

  const [entry] = await db("shortlist_entries")
    .where({ id: request.params.id })
    .whereNull("removed_at")
    .update({ notes: notes ?? null })
    .returning("*");

  if (!entry) {
    response.status(404).json({ error: "Entry not found or already removed." });
    return;
  }
  response.json({ notes: entry.notes });
});

screenerRouter.delete("/:id", async (request, response) => {
  const updatedCount = await db("shortlist_entries")
    .where({ id: request.params.id })
    .whereNull("removed_at")
    .update({ removed_at: db.fn.now() });

  if (updatedCount === 0) {
    response.status(404).json({ error: "Entry not found or already removed." });
    return;
  }
  response.status(204).end();
});
