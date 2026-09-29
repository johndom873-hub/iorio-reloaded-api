import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";
import { buildSignalsRoadmap } from "../lib/signalsRoadmap.js";
import { loadAccountContext, loadRoadmapCounts, loadSignalsUniverseTicker, loadSignalsScreen, loadTickerSignals } from "../lib/signalsStore.js";
import { loadSignalContractScore, loadSignalsChain, loadTickerBySymbol, type LiveSpot } from "../lib/signalsChainStore.js";

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
  const ticker = await loadSignalsUniverseTicker(request.params.symbol);
  if (!ticker) {
    response.status(404).json({ error: `${request.params.symbol.toUpperCase()} is not on the shortlist and has no open short option leg` });
    return;
  }
  const accountContext = await loadAccountContext();
  response.json(await loadTickerSignals(ticker, accountContext, { withUncompensatedShare: true }));
});

/** YYYY-MM-DD or YYYYMMDD in, YYYY-MM-DD out; null when absent, undefined when malformed. */
function parseExpiryParameter(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return undefined;
}

/** The modal's live spot, so the chain and the contract score match its live-scored candidates; absent scores at the snapshot spot. */
function parseLiveSpotParameter(value: unknown): LiveSpot | undefined {
  if (value === undefined) return null;
  const spotPrice = Number(value);
  return Number.isFinite(spotPrice) && spotPrice > 0 ? { spotPrice, priceSource: "live" } : undefined;
}

// Full option chain for the Signals modal: every stored strike of one expiry, calls and puts, as candidate / filtered / not_captured.
signalsRouter.get("/:symbol/chain", async (request, response) => {
  const expiry = parseExpiryParameter(request.query.expiry);
  const liveSpot = parseLiveSpotParameter(request.query.spotPrice);
  if (expiry === undefined) {
    response.status(400).json({ error: "expiry must be a YYYY-MM-DD or YYYYMMDD date." });
    return;
  }
  if (liveSpot === undefined) {
    response.status(400).json({ error: "spotPrice must be a positive number." });
    return;
  }
  const ticker = await loadTickerBySymbol(request.params.symbol);
  if (!ticker) {
    response.status(404).json({ error: `${request.params.symbol.toUpperCase()} is not a known ticker.` });
    return;
  }
  response.json(await loadSignalsChain(ticker, expiry, liveSpot));
});

// One arbitrary contract scored like a Signals candidate (filters lifted), from one pooled live quote or the stored one.
signalsRouter.get("/:symbol/contract", async (request, response) => {
  const expiry = parseExpiryParameter(request.query.expiry);
  const strike = Number(request.query.strike);
  const right = request.query.right;
  const liveSpot = parseLiveSpotParameter(request.query.spotPrice);
  if (!expiry) {
    response.status(400).json({ error: "expiry is required as a YYYY-MM-DD or YYYYMMDD date." });
    return;
  }
  if (!Number.isFinite(strike) || strike <= 0) {
    response.status(400).json({ error: "strike must be a positive number." });
    return;
  }
  if (right !== "C" && right !== "P") {
    response.status(400).json({ error: "right must be C or P." });
    return;
  }
  if (liveSpot === undefined) {
    response.status(400).json({ error: "spotPrice must be a positive number." });
    return;
  }
  const ticker = await loadTickerBySymbol(request.params.symbol);
  if (!ticker) {
    response.status(404).json({ error: `${request.params.symbol.toUpperCase()} is not a known ticker.` });
    return;
  }
  response.json(await loadSignalContractScore(ticker, { expiry, strike, right }, liveSpot));
});
