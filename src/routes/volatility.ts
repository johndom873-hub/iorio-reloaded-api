import { Router } from "express";
import { loadTradingSettings } from "../lib/tradingSettingsStore.js";
import { touchVolatilityDemand, type DeltaBand } from "../lib/volatilityLive.js";
import { loadVolatilityScreen, type BestCallYield, type VolatilityRow } from "../lib/volatilityScreen.js";

// The Volatility screen (Marcelo 2026-10-27). Each request also tells the market quote loop that this delta band is
// wanted (a lease, volatilityLive.ts), so the loop quotes Calls only while a Volatility screen or Pulse is open.

export const volatilityRouter = Router();

/** Pulse's Top premiums: this many tickers, by best 0-7 DTE Call yield (Marcelo 2026-10-27). */
export const topPremiumsCount = 10;

function parseDeltaBand(minRaw: unknown, maxRaw: unknown): DeltaBand | { error: string } | null {
  if (minRaw === undefined && maxRaw === undefined) return null;
  const min = Number(minRaw);
  const max = Number(maxRaw);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 1 || !(min < max)) return { error: "deltaMin and deltaMax must be numbers with 0 ≤ deltaMin < deltaMax ≤ 1." };
  // Rounded to the hundredth so near-identical bands share one lease (and one set of quoted Calls).
  return { min: Math.round(min * 100) / 100, max: Math.round(max * 100) / 100 };
}

async function riskLimitsBand(): Promise<DeltaBand> {
  const settings = await loadTradingSettings();
  return { min: settings.deltaTargetMin, max: settings.deltaTargetMax };
}

volatilityRouter.get("/", async (request, response) => {
  const parsed = parseDeltaBand(request.query.deltaMin, request.query.deltaMax);
  if (parsed && "error" in parsed) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  const band = parsed ?? (await riskLimitsBand());
  touchVolatilityDemand(band);
  response.json({ ...(await loadVolatilityScreen(band)), riskLimitsBand: await riskLimitsBand() });
});

export interface TopPremiumRow {
  tickerId: string;
  symbol: string;
  best: BestCallYield;
}

volatilityRouter.get("/top-premiums", async (_request, response) => {
  const band = await riskLimitsBand();
  touchVolatilityDemand(band);
  const screen = await loadVolatilityScreen(band);
  const ranked = screen.rows
    .filter((row): row is VolatilityRow & { bestCallYields: { upTo7: BestCallYield } } => row.bestCallYields.upTo7 !== null)
    .sort((a, b) => b.bestCallYields.upTo7.yield - a.bestCallYields.upTo7.yield)
    .slice(0, topPremiumsCount)
    .map((row): TopPremiumRow => ({ tickerId: row.tickerId, symbol: row.symbol, best: row.bestCallYields.upTo7 }));
  response.json({ asOf: screen.asOf, deltaBand: band, tickerCount: screen.rows.length, rows: ranked });
});

// One ticker's row for the Ticker modal's volatility strip. Registers no demand: opening a modal does not start the
// loop's Call quotes (its best yields appear only while a Volatility screen or Pulse keeps them quoted).
volatilityRouter.get("/ticker/:symbol", async (request, response) => {
  const screen = await loadVolatilityScreen(await riskLimitsBand());
  const row = screen.rows.find((entry) => entry.symbol.toUpperCase() === request.params.symbol.toUpperCase());
  if (!row) {
    response.status(404).json({ error: `${request.params.symbol.toUpperCase()} is not on the Shortlist and has no open position, so it has no volatility row.` });
    return;
  }
  response.json(row);
});
