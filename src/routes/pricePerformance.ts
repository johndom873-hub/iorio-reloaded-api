import { Router, type Request, type Response } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { streamLivePrices, type PriceContract } from "../ibkr/fetchLivePrices.js";
import { getPricePerformanceSnapshot } from "../lib/pricePerformanceSnapshot.js";
import { getPriceBarsRefreshStatus, startPriceBarsRefresh } from "../lib/priceBarsRefresh.js";

export const pricePerformanceRouter = Router();
pricePerformanceRouter.use(requireAuth);

// The whole table minus the live price, from daily_price_bars alone — no IBKR
// call of any kind (design: PROGRESS.md "Price Performance redesign"). Completed
// session bars only; trend labels (MACD, moving averages) are computed here in
// one pass, which is why the old blocking /trends endpoint no longer exists.
// Express's built-in ETag makes a repeat load with unchanged data a 304 with no
// body; `no-cache` makes the browser ask every time instead of guessing.
pricePerformanceRouter.get("/", async (_request, response) => {
  const snapshot = await getPricePerformanceSnapshot();
  response.setHeader("Cache-Control", "private, no-cache");
  response.json({
    tickers: snapshot.tickers,
    meta: {
      ...snapshot.meta,
      refresh: { ...getPriceBarsRefreshStatus(), refreshableSymbolCount: snapshot.meta.refreshableSymbols.length },
    },
  });
});

// The page's explicit "Refresh daily data" button — the only way this screen
// can cause an IBKR read. Returns at once (202) and works in the background;
// open pages reload on the job_completed notification. See priceBarsRefresh.ts.
pricePerformanceRouter.post("/refresh", async (request, response) => {
  const result = await startPriceBarsRefresh(request.session.userId!);
  response.status(result.status === "started" ? 202 : 200).json(result);
});

// Live current price only, for every shortlisted ticker — nothing else. The
// browser already holds each ticker's reference closes (from GET / above) and
// computes the live % changes itself, so this stream no longer queries the
// database or recomputes anything per connection; that also removes the old
// risk of this route and GET / disagreeing on what "N days back" means (they
// used to share one SQL fragment for exactly that reason). Same SSE
// FROZEN-then-REALTIME mechanics as positions.ts's pnl/stream (see that
// route's comments) — streamLivePrices borrows the shared read connection
// (falling back to a one-shot one), the same read-only path Positions uses,
// not the worker's persistent trading connection.
export async function streamPricePerformancePricesHandler(request: Request, response: Response): Promise<void> {
  const symbolRows = await db("tickers as t")
    .select("t.symbol")
    .whereExists(function () {
      this.select(1).from("shortlist_entries as se").whereRaw("se.ticker_id = t.id").andWhere("se.removed_at", null);
    })
    .orderBy("t.symbol");
  const symbols = (symbolRows as { symbol: string }[]).map((row) => row.symbol);

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 20_000);

  if (symbols.length === 0) {
    send({});
    clearInterval(heartbeat);
    response.end();
    return;
  }

  const priceContracts: PriceContract[] = symbols.map((symbol) => ({ key: symbol, legType: "stock", symbol }));

  try {
    await streamLivePrices(priceContracts, (pricesBySymbol) => send(pricesBySymbol), abortController.signal);
  } catch (error) {
    console.error("price-performance/current-prices/stream: streamLivePrices failed", error);
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
}

pricePerformanceRouter.get("/current-prices/stream", streamPricePerformancePricesHandler);
