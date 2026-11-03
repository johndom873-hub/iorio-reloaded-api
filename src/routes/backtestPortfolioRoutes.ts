import type { Router } from "express";
import { listPortfolioTickers, parsePortfolioBookRequest, simulatePortfolio, suggestPortfolioChanges } from "../backtest/portfolio/portfolioSimulatorStore.js";

// The portfolio simulator's routes (under /backtest, the lab only): every analysed ticker for the book's picker, a book's
// projection, and its one-change suggestions streamed over SSE (a few seconds: every candidate is a projection of its own).

const suggestionsHeartbeatMs = 15_000;

export function registerPortfolioSimulatorRoutes(router: Router): void {
  router.get("/portfolio/tickers", async (_request, response) => {
    response.json({ tickers: await listPortfolioTickers() });
  });

  router.post("/portfolio/simulate", async (request, response) => {
    response.json(await simulatePortfolio(parsePortfolioBookRequest(request.body)));
  });

  // The book as JSON in ?book= (EventSource sends no body): events "progress" {done, total}, then "result" or "failure".
  router.get("/portfolio/suggestions/stream", async (request, response) => {
    let book: ReturnType<typeof parsePortfolioBookRequest>;
    try {
      book = parsePortfolioBookRequest(JSON.parse(typeof request.query.book === "string" ? request.query.book : "null"));
    } catch (error) {
      response.status(400).json({ error: error instanceof SyntaxError ? "book must be the book as JSON." : error instanceof Error ? error.message : String(error) });
      return;
    }
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    response.on("error", () => {});
    const send = (event: string, data: unknown) => {
      if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": ping\n\n");
    }, suggestionsHeartbeatMs);
    try {
      let lastSent = 0;
      const result = await suggestPortfolioChanges(book, (done, total) => {
        if (done === total || Date.now() - lastSent > 250) {
          lastSent = Date.now();
          send("progress", { done, total });
        }
      });
      send("result", result);
    } catch (error) {
      send("failure", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearInterval(heartbeat);
      response.end();
    }
  });
}
