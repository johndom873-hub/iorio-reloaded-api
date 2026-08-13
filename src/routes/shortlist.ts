import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { lookupTickerDetails } from "../ibkr/lookupTickerDetails.js";

export const shortlistRouter = Router();
shortlistRouter.use(requireAuth);

// v1 strategy scope — see PROGRESS.md "Decisions made".
const validStrategyKeys = ["covered_call", "cash_secured_put"];

shortlistRouter.get("/", async (request, response) => {
  const strategyKey = request.query.strategy as string | undefined;
  if (!strategyKey || !validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "A valid strategy query parameter is required." });
    return;
  }

  const entries = await db("shortlist_entries")
    .join("tickers", "tickers.id", "shortlist_entries.ticker_id")
    .where({ "shortlist_entries.strategy_key": strategyKey })
    .whereNull("shortlist_entries.removed_at")
    .select(
      "shortlist_entries.id",
      "shortlist_entries.strategy_key as strategyKey",
      "shortlist_entries.added_at as addedAt",
      "shortlist_entries.notes",
      "tickers.id as tickerId",
      "tickers.symbol",
      "tickers.company_name as companyName",
      "tickers.sector",
    )
    .orderBy("tickers.symbol");

  response.json(entries);
});

shortlistRouter.post("/", async (request, response) => {
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
    const details = await lookupTickerDetails(normalizedSymbol);
    [ticker] = await db("tickers")
      .insert({ symbol: normalizedSymbol, company_name: details.companyName, sector: details.sector })
      .returning("*");
  }

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
    });
  } catch (error) {
    // Partial unique index on (ticker_id, strategy_key) WHERE removed_at IS NULL.
    if ((error as { code?: string }).code === "23505") {
      response.status(409).json({ error: `${normalizedSymbol} is already on the ${strategyKey} shortlist.` });
      return;
    }
    throw error;
  }
});

shortlistRouter.delete("/:id", async (request, response) => {
  const updatedCount = await db("shortlist_entries")
    .where({ id: request.params.id })
    .whereNull("removed_at")
    .update({ removed_at: db.fn.now() });

  if (updatedCount === 0) {
    response.status(404).json({ error: "Shortlist entry not found or already removed." });
    return;
  }
  response.status(204).end();
});
