import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { lookupTickerDetails } from "../ibkr/lookupTickerDetails.js";

export const tickersRouter = Router();
tickersRouter.use(requireAuth);

// The full watchlist that the Screener scans daily — a superset of whatever
// is currently on a strategy's shortlist. See PROGRESS.md's Screener
// ticker-universe decision.
tickersRouter.get("/", async (_request, response) => {
  const tickers = await db("tickers").select("id", "symbol", "company_name", "sector").orderBy("symbol");
  response.json(tickers);
});

tickersRouter.post("/", async (request, response) => {
  const { symbol, companyName, sector } = request.body as {
    symbol?: string;
    companyName?: string;
    sector?: string;
  };

  if (!symbol || !symbol.trim()) {
    response.status(400).json({ error: "Symbol is required." });
    return;
  }
  const normalizedSymbol = symbol.trim().toUpperCase();

  const existing = await db("tickers").where({ symbol: normalizedSymbol }).first();
  if (existing) {
    response.json(existing);
    return;
  }

  let resolvedCompanyName = companyName ?? null;
  let resolvedSector = sector ?? null;
  if (!resolvedCompanyName && !resolvedSector) {
    const details = await lookupTickerDetails(normalizedSymbol);
    resolvedCompanyName = details.companyName;
    resolvedSector = details.sector;
  }

  const [ticker] = await db("tickers")
    .insert({ symbol: normalizedSymbol, company_name: resolvedCompanyName, sector: resolvedSector })
    .returning(["id", "symbol", "company_name", "sector"]);
  response.status(201).json(ticker);
});
