import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { streamTickerDetail } from "../ibkr/streamTickerDetail.js";
import { streamPositionQuote } from "../ibkr/streamPositionQuote.js";
import { fetchPriceBars, type ChartRange } from "../ibkr/fetchTickerOverview.js";
import { fetchTickerQuoteSnapshot } from "../ibkr/fetchTickerQuoteSnapshot.js";

export const tickerDetailRouter = Router();
tickerDetailRouter.use(requireAuth);

const validChartRanges: ChartRange[] = ["1D", "5D", "1M", "3M", "6M", "1Y", "5Y", "All"];
const heartbeatIntervalMs = 20_000;

// Platform-wide: any screen showing a ticker symbol opens the same modal
// backed by this route, not a Screener-specific endpoint.
//
// SSE, not a single blocking response — see streamTickerDetail.ts for why:
// the option chain alone can take 15-25s, and its retry-on-timeout logic
// can theoretically stack up past Heroku's 30s router timeout under bad
// IBKR conditions. Streaming each section as it resolves also means the
// modal shows pricing/chart well before the option chain is ready, instead
// of blocking the whole thing on the slowest piece. Same SSE shape as
// menaris-admin-api's /system/health route: headers + send() + heartbeat +
// finally cleanup.
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

  try {
    await streamTickerDetail(symbol, send, abortController.signal);
    send({ type: "done" });
  } catch (error) {
    send({ type: "streamError", message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
});

// New Position form's live-quote lookup: pricing + option chain only, no
// chart. See streamPositionQuote.ts for why this isn't just streamTickerDetail
// with the chart event ignored client-side.
tickerDetailRouter.get("/:symbol/position-quote/stream", async (request, response) => {
  const symbol = request.params.symbol.toUpperCase();

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

  try {
    await streamPositionQuote(symbol, send);
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

  const bars = await fetchPriceBars(symbol, range as ChartRange);
  response.json(bars);
});
