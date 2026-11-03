import type { Response, Router } from "express";
import { parsePortfolioProjectionRequest, portfolioPots, projectPortfolio } from "../backtest/portfolio/portfolioProjectionStore.js";
import { listPortfolioTickers, parsePortfolioBookRequest, simulatePortfolio, suggestPortfolioChanges } from "../backtest/portfolio/portfolioSimulatorStore.js";

// The portfolio simulator's routes (under /backtest, the lab only): every analysed ticker for the book's picker, how a
// book's tickers move together, its pot table and suggested allocations, its projection streamed over SSE (minutes: every
// path is the book run through v4's own days), and its one-change suggestions streamed over SSE.

const streamHeartbeatMs = 15_000;

/** The request as JSON in ?book= (EventSource sends no body), parsed; a 400 with the message when it isn't one. */
function parseQueryBook<Parsed>(query: unknown, response: Response, parse: (body: unknown) => Parsed): Parsed | null {
  try {
    return parse(JSON.parse(typeof query === "string" ? query : "null"));
  } catch (error) {
    response.status(400).json({ error: error instanceof SyntaxError ? "book must be the book as JSON." : error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Runs `work` behind an event stream: "progress" {done, total} at most every 250 ms and at the end, then "result" or "failure". */
async function streamWork<Result>(response: Response, work: (onProgress: (done: number, total: number) => void) => Promise<Result>): Promise<void> {
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
  }, streamHeartbeatMs);
  try {
    let lastSent = 0;
    const result = await work((done, total) => {
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
}

export function registerPortfolioSimulatorRoutes(router: Router): void {
  router.get("/portfolio/tickers", async (_request, response) => {
    response.json({ tickers: await listPortfolioTickers() });
  });

  router.post("/portfolio/simulate", async (request, response) => {
    response.json(await simulatePortfolio(parsePortfolioBookRequest(request.body)));
  });

  router.post("/portfolio/pots", async (request, response) => {
    response.json(await portfolioPots(parsePortfolioBookRequest(request.body)));
  });

  // The book, drift and path count as JSON in ?book=.
  router.get("/portfolio/projection/stream", async (request, response) => {
    const book = parseQueryBook(request.query.book, response, parsePortfolioProjectionRequest);
    if (book !== null) await streamWork(response, (onProgress) => projectPortfolio(book, onProgress));
  });

  // The book as JSON in ?book=.
  router.get("/portfolio/suggestions/stream", async (request, response) => {
    const book = parseQueryBook(request.query.book, response, parsePortfolioBookRequest);
    if (book !== null) await streamWork(response, (onProgress) => suggestPortfolioChanges(book, onProgress));
  });
}
