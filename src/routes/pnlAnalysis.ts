import { Router } from "express";
import { loadPnlAnalysis } from "../lib/pnlAnalysis.js";
import { loadTickerCycleAnalysis } from "../lib/pnlTickerCycles.js";
import { requireAuth } from "../middleware/requireAuth.js";

// The P&L Analyser (Marcelo 2026-11-13): GET /pnl-analysis?from=YYYY-MM-DD&to=YYYY-MM-DD, every book at once (All, Pluto,
// Manual), from the stored nightly attribution (lib/pnlAnalysis.ts). Either date left out = the whole history.
export const pnlAnalysisRouter = Router();
pnlAnalysisRouter.use(requireAuth);

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function optionalIsoDate(value: unknown): string | null | "invalid" {
  if (value === undefined || value === "") return null;
  return typeof value === "string" && isoDatePattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : "invalid";
}

pnlAnalysisRouter.get("/", async (request, response) => {
  const from = optionalIsoDate(request.query.from);
  const to = optionalIsoDate(request.query.to);
  if (from === "invalid" || to === "invalid") {
    response.status(400).json({ error: "from and to must be dates as YYYY-MM-DD" });
    return;
  }
  if (from !== null && to !== null && from > to) {
    response.status(400).json({ error: "from must not be after to" });
    return;
  }
  response.json(await loadPnlAnalysis(from, to));
});

// One ticker's cycles over the same range (lib/pnlTickerCycles.ts): GET /pnl-analysis/ticker-cycles?symbol=NVDA&book=all|pluto|manual&from&to.
pnlAnalysisRouter.get("/ticker-cycles", async (request, response) => {
  const symbol = String(request.query.symbol ?? "").trim().toUpperCase();
  const book = request.query.book ?? "all";
  const from = optionalIsoDate(request.query.from);
  const to = optionalIsoDate(request.query.to);
  if (!symbol) {
    response.status(400).json({ error: "symbol is required" });
    return;
  }
  if (book !== "all" && book !== "pluto" && book !== "manual") {
    response.status(400).json({ error: "book must be all, pluto or manual" });
    return;
  }
  if (from === "invalid" || to === "invalid" || (from !== null && to !== null && from > to)) {
    response.status(400).json({ error: "from and to must be dates as YYYY-MM-DD, from not after to" });
    return;
  }
  const analysis = await loadTickerCycleAnalysis(symbol, book, from, to);
  if (analysis === null) {
    response.status(404).json({ error: `Unknown ticker ${symbol}` });
    return;
  }
  response.json(analysis);
});
