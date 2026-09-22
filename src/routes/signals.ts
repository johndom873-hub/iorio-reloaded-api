import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";
import { buildSignalsRoadmap } from "../lib/signalsRoadmap.js";
import { loadAccountContext, loadRoadmapCounts, loadShortlistTicker, loadSignalsScreen, loadTickerSignals } from "../lib/signalsStore.js";

// Snapshot-priced first paint for the Signals screen and modal (mockup approved
// 2026-09-22); the live re-scoring runs over the stream multiplexer
// (signalsScreen / signalsTicker producers).

export const signalsRouter = Router();
signalsRouter.use(requireAuth);

signalsRouter.get("/", async (_request, response) => {
  response.json(await loadSignalsScreen());
});

// Before "/:symbol" so "roadmap" is never read as a ticker.
signalsRouter.get("/roadmap", async (_request, response) => {
  const now = new Date();
  response.json({ asOfDateIso: easternDateIso(now), items: buildSignalsRoadmap(await loadRoadmapCounts(now), easternDateIso(now)) });
});

signalsRouter.get("/:symbol", async (request, response) => {
  const ticker = await loadShortlistTicker(request.params.symbol);
  if (!ticker) {
    response.status(404).json({ error: `${request.params.symbol.toUpperCase()} is not on the shortlist` });
    return;
  }
  const accountContext = await loadAccountContext();
  response.json(await loadTickerSignals(ticker, accountContext, { withUncompensatedShare: true }));
});
