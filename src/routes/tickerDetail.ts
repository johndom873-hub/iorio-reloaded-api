import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allTickerDetailStreamSections, streamTickerDetail, type TickerDetailStreamSection } from "../ibkr/streamTickerDetail.js";
import type { ChartRange } from "../ibkr/fetchTickerOverview.js";
import { fetchCachedPriceBars, fetchCachedIvBars, type IvChartRange } from "../ibkr/priceBarCache.js";
import { fetchTickerQuoteSnapshot } from "../ibkr/fetchTickerQuoteSnapshot.js";
import { respondWithStreamedResult } from "../lib/streamedResponse.js";
import { streamPooledStockPrices } from "../ibkr/pricePool.js";

export const tickerDetailRouter = Router();
tickerDetailRouter.use(requireAuth);

const validChartRanges: ChartRange[] = ["1D", "5D", "1M", "3M", "6M", "1Y", "5Y", "All"];
const heartbeatIntervalMs = 20_000;

// Platform-wide: any screen showing a ticker symbol opens the same modal
// backed by this route, not a Screener-specific endpoint.
//
// SSE, not a single blocking response: prices keep streaming while the modal
// is open, and each section is sent as soon as it resolves instead of
// blocking on the slowest one. Headers + send() + heartbeat + finally cleanup.
/**
 * Live last price for whatever stock symbols the client lists (?symbols=A,B) —
 * a generic stream (Dashboard "Needs Attention" is the current reader), also
 * served as the multiplexer's "stockPrices" kind. The client passes the exact
 * set it shows rather than this route re-deriving it. No historical-close
 * comparison, just the live price; pooled, so symbols another screen already
 * streams cost no extra IBKR lines.
 */
export async function streamStockPricesHandler(request: Request, response: Response): Promise<void> {
  const symbolsParam = typeof request.query.symbols === "string" ? request.query.symbols : "";
  const symbols = Array.from(new Set(symbolsParam.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)));

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, heartbeatIntervalMs);

  if (symbols.length === 0) {
    send({});
    clearInterval(heartbeat);
    response.end();
    return;
  }

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  try {
    await streamPooledStockPrices(symbols, (pricesBySymbol) => send(pricesBySymbol), abortController.signal);
  } catch (error) {
    console.error("tickers/current-prices/stream: streamPooledStockPrices failed", error);
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
}

tickerDetailRouter.get("/current-prices/stream", streamStockPricesHandler);

tickerDetailRouter.get("/:symbol/detail/stream", async (request, response) => {
  const symbol = request.params.symbol.toUpperCase();

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  // A client that navigates away or (in dev) has React StrictMode close the
  // very first of its two mount-effect EventSources can disconnect at any
  // point during the 15-25s this stream stays open. Writing to a socket the
  // client already closed emits an 'error' event on the response stream —
  // with no listener, Node treats that as an uncaught exception and kills
  // the whole process (verified by reproducing it: the dyno-equivalent dev
  // process crashed outright, not just this one request). This listener is
  // what makes that a normal, silent no-op instead.
  response.on("error", () => {});

  // Prices now stream continuously (approved 2026-08-26) instead of
  // resolving once, so streamTickerDetail only returns once this aborts —
  // i.e. once the client actually disconnects (modal closed, tab
  // navigated away, EventSource.close() called client-side).
  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, heartbeatIntervalMs);

  // ?sections=overview,spot,chart,technicals limits what is streamed; absent = everything.
  const rawSections = typeof request.query.sections === "string" ? request.query.sections.split(",").map((section) => section.trim()).filter(Boolean) : null;
  const unknownSection = rawSections?.find((section) => !(allTickerDetailStreamSections as readonly string[]).includes(section));
  if (unknownSection) {
    send({ type: "streamError", message: `Unknown section "${unknownSection}".` });
    clearInterval(heartbeat);
    response.end();
    return;
  }

  try {
    await streamTickerDetail(symbol, send, abortController.signal, (rawSections as TickerDetailStreamSection[] | null) ?? undefined);
    send({ type: "done" });
  } catch (error) {
    send({ type: "streamError", message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
});

// Blocking (not SSE) quote lookup — built for Genosuke's get_ticker_quote
// tool call (a plain request/response, not a UI that can consume a stream),
// but usable by anything else that wants a one-shot quote. See
// fetchTickerQuoteSnapshot.ts for why this always returns a last-known
// price but only best-effort live pricing/option chain.
tickerDetailRouter.get("/:symbol/quote", async (request, response) => {
  const symbol = request.params.symbol.toUpperCase();
  const snapshot = await fetchTickerQuoteSnapshot(symbol);
  response.json(snapshot);
});

tickerDetailRouter.get("/:symbol/chart", async (request, response) => {
  const symbol = request.params.symbol.toUpperCase();
  const range = request.query.range as string | undefined;
  if (!range || !validChartRanges.includes(range as ChartRange)) {
    response.status(400).json({ error: "A valid range query parameter is required." });
    return;
  }

  // Streamed (2026-09-24): a cold cache backfills 20 years of daily bars
  // plus implied volatility, past Heroku's 30 s router timeout.
  await respondWithStreamedResult(response, async () => ({ status: 200, body: await fetchCachedPriceBars(symbol, range as ChartRange) }));
});

const validIvChartRanges: IvChartRange[] = ["1Y", "5Y", "All"];

// Daily-only (see fetchCachedIvBars's header comment) — the price chart's
// four intraday ranges don't apply, IBKR's IV history is one value per day.
tickerDetailRouter.get("/:symbol/iv-chart", async (request, response) => {
  const symbol = request.params.symbol.toUpperCase();
  const range = request.query.range as string | undefined;
  if (!range || !validIvChartRanges.includes(range as IvChartRange)) {
    response.status(400).json({ error: "A valid range query parameter (1Y, 5Y, or All) is required." });
    return;
  }

  const points = await fetchCachedIvBars(symbol, range as IvChartRange);
  response.json(points);
});
