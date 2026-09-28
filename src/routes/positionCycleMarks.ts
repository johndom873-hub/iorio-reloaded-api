import type { Request, Response } from "express";
import { db } from "../db/connection.js";
import { loadCycleInputsForTickers } from "../lib/cycleQueries.js";
import { computeOpenCycleMarks, type OpenCycleMarks } from "../lib/cycleLiveMarks.js";

// Stored-mark cycle figures for every ticker with an open position, for the Positions table's Cycle P&L column
// (see cycleLiveMarks.ts). Read-only; the live part is applied in the browser.
export async function getCycleMarksHandler(_request: Request, response: Response): Promise<void> {
  const tickers: { tickerId: string; symbol: string }[] = await db("positions as p")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where("p.status", "open")
    .distinct("p.ticker_id as tickerId", "t.symbol as symbol");
  const marksBySymbol: Record<string, OpenCycleMarks> = {};
  if (tickers.length > 0) {
    const inputs = await loadCycleInputsForTickers(tickers.map((ticker) => ticker.tickerId));
    for (const { symbol, input } of inputs) {
      const marks = computeOpenCycleMarks(symbol, input);
      if (marks) marksBySymbol[symbol] = marks;
    }
  }
  response.json(marksBySymbol);
}
