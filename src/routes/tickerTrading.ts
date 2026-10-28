import { formatExpiryAsIsoDate } from "../lib/expiryFormat.js";
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { db } from "../db/connection.js";
import { loadStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { liveExpiryStrikes, liveListedExpirations } from "../ibkr/liveOptionChainLookups.js";
import { peekPooledQuote } from "../ibkr/marketDataPool.js";
import { fetchDividendOutlook, type DividendOutlook } from "../ibkr/fetchDividendOutlook.js";
import { borrowSharedConnectionOrConnect, nextReqIdFor, sharedReadConnection } from "../ibkr/sharedReadConnection.js";
import { loadAccountContext } from "../lib/accountContext.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { loadUpcomingMajorMacroEvents } from "../lib/macroEventCalendar.js";
import { calendarDaysUntilExpiry } from "../lib/optionChainExpiryRange.js";
import { loadOpenShortLegs } from "../lib/openShortLegs.js";
import { getRiskFreeRate } from "../lib/riskFreeRate.js";
import { fetchAvailableUncoveredShares } from "../lib/positionQueries.js";
import { loadNextEarningsDate } from "../lib/tickerCalendarQueries.js";
import { loadTradingSettings } from "../lib/tradingSettingsStore.js";

// The Ticker modal's data (2026-10-27, replacing /signals/:symbol): what a ticker's order forms need (free shares and
// cash, the open short legs a roll starts from, the spread cost and the macro calendar), and its option chain: every
// listed expiry, the strikes from the stored structure, else looked up live at IBKR (a ticker outside the option-data
// universe, or an expiry past the stored 90 days). Live quotes for the chain's cells come from the `optionQuotes` stream.

export const tickerTradingRouter = Router();
tickerTradingRouter.use(requireAuth);

interface TickerRow {
  id: string;
  symbol: string;
  companyName: string | null;
  contractId: number | null;
}

async function loadTicker(symbol: string): Promise<TickerRow | null> {
  const row = await db("tickers").whereRaw("upper(symbol) = ?", [symbol.toUpperCase()]).first("id", "symbol", "company_name as companyName", "ibkr_contract_id as contractId");
  return row ? { ...row, contractId: row.contractId === null ? null : Number(row.contractId) } : null;
}

tickerTradingRouter.get("/:symbol/trading-context", async (request, response) => {
  const ticker = await loadTicker(request.params.symbol);
  if (!ticker) {
    response.status(404).json({ error: `${request.params.symbol.toUpperCase()} is not a known ticker.` });
    return;
  }
  const todayIso = easternIsoDate(new Date());
  const [freeShares, account, heldLegs, settings, macroEvents, nextEarningsDateIso] = await Promise.all([
    fetchAvailableUncoveredShares(ticker.id),
    loadAccountContext().catch(() => null),
    loadOpenShortLegs(ticker.id),
    loadTradingSettings(),
    loadUpcomingMajorMacroEvents(),
    loadNextEarningsDate(ticker.id, todayIso),
  ]);
  response.json({
    symbol: ticker.symbol,
    companyName: ticker.companyName,
    freeShares,
    freeCash: account?.freeCash ?? null,
    heldLegs,
    spreadShareCharged: settings.spreadCostChargedPct / 100,
    macroEvents,
    nextEarningsDateIso,
  });
});

// What the LEAPS P&L-over-time chart values a Call with (approved by Marcelo 2026-10-27): IBKR's dividends expected over the next
// 12 months (generic tick 456; the app divides by the stock price for the yield) and the FRED risk-free rate. IBKR's figure is
// kept for the Eastern day per ticker; when IBKR sends nothing in time it comes back null and the chart leaves dividends out.
const dividendOutlookTimeoutMs = 8_000;
const dividendOutlookCache = new Map<string, { dayIso: string; outlook: DividendOutlook }>();
let fallbackDividendRequestId = 970_000;

async function loadDividendOutlook(symbol: string): Promise<DividendOutlook | null> {
  const dayIso = easternIsoDate(new Date());
  const cached = dividendOutlookCache.get(symbol);
  if (cached && cached.dayIso === dayIso) return cached.outlook;
  const connection = await borrowSharedConnectionOrConnect(sharedReadConnection, "valuation inputs");
  try {
    const outlook = await fetchDividendOutlook(connection, nextReqIdFor(connection.ib, () => fallbackDividendRequestId++), symbol, dividendOutlookTimeoutMs);
    // No tick in time is not kept: the next request asks IBKR again.
    if (outlook) dividendOutlookCache.set(symbol, { dayIso, outlook });
    return outlook;
  } finally {
    connection.disconnect();
  }
}

tickerTradingRouter.get("/:symbol/valuation-inputs", async (request, response) => {
  const ticker = await loadTicker(request.params.symbol);
  if (!ticker) {
    response.status(404).json({ error: `${request.params.symbol.toUpperCase()} is not a known ticker.` });
    return;
  }
  const [outlook, riskFreeRate] = await Promise.all([
    loadDividendOutlook(ticker.symbol).catch((error) => {
      console.warn(`Valuation inputs: no IBKR dividend outlook for ${ticker.symbol} (${error instanceof Error ? error.message : error}).`);
      return null;
    }),
    getRiskFreeRate().catch(() => null),
  ]);
  response.json({ symbol: ticker.symbol, nextTwelveMonthsDividends: outlook?.nextTwelveMonths ?? null, nextDividendDate: outlook?.nextDate ?? null, riskFreeRate });
});


tickerTradingRouter.get("/:symbol/option-chain", async (request, response) => {
  const ticker = await loadTicker(request.params.symbol);
  if (!ticker) {
    response.status(404).json({ error: `${request.params.symbol.toUpperCase()} is not a known ticker.` });
    return;
  }
  const requestedExpiry = typeof request.query.expiry === "string" ? request.query.expiry.replaceAll("-", "") : null;
  if (requestedExpiry !== null && !/^\d{8}$/.test(requestedExpiry)) {
    response.status(400).json({ error: "expiry must be a YYYY-MM-DD or YYYYMMDD date." });
    return;
  }
  const todayIso = easternIsoDate(new Date());
  const todayYyyymmdd = todayIso.replaceAll("-", "");
  const stored = await loadStoredOptionChain(ticker.id);
  let expirations = stored.expirations.filter((expiry) => expiry >= todayYyyymmdd).sort();
  try {
    if (expirations.length === 0) {
      if (ticker.contractId === null) {
        response.status(409).json({ error: `${ticker.symbol} has no IBKR contract id stored, so its option chain cannot be looked up.` });
        return;
      }
      const live = await liveListedExpirations({ id: ticker.id, symbol: ticker.symbol, contractId: ticker.contractId }, todayIso, "ticker-option-chain");
      expirations = live.filter((expiry) => expiry >= todayYyyymmdd).sort();
    }
    const selected = requestedExpiry !== null && expirations.includes(requestedExpiry) ? requestedExpiry : (expirations[0] ?? null);
    let strikes: number[] = [];
    let strikesSource: "stored" | "live" | null = null;
    if (selected !== null) {
      const storedStrikes = stored.strikesByExpiry.get(selected);
      if (storedStrikes && storedStrikes.length > 0) {
        strikes = storedStrikes;
        strikesSource = "stored";
      } else {
        strikes = await liveExpiryStrikes(ticker, selected, todayIso, "ticker-option-chain");
        strikesSource = "live";
      }
    }
    const pooled = peekPooledQuote({ key: `${ticker.symbol}|stock`, legType: "stock", symbol: ticker.symbol });
    const close = pooled?.last ? null : await db("daily_price_bars").where({ ticker_id: ticker.id }).whereNotNull("close_price").orderBy("trading_date", "desc").first("close_price as close");
    response.json({
      symbol: ticker.symbol,
      spotPrice: pooled?.last ?? (close ? Number(close.close) : null),
      expiries: expirations.map((expiry) => ({ expiry: formatExpiryAsIsoDate(expiry), dte: calendarDaysUntilExpiry(todayIso, expiry) })),
      selectedExpiry: selected === null ? null : formatExpiryAsIsoDate(selected),
      strikes: [...strikes].sort((a, b) => a - b),
      strikesSource,
    });
  } catch (error) {
    response.status(502).json({ error: `Could not look up ${ticker.symbol}'s option chain at IBKR: ${error instanceof Error ? error.message : error}` });
  }
});
