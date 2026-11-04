import type { Response, Router } from "express";
import { parsePortfolioProjectionRequest, portfolioPots, projectPortfolio } from "../backtest/portfolio/portfolioProjectionStore.js";
import { portfolioLibraryStatus } from "../backtest/portfolio/portfolioLibraryStatus.js";
import { suggestPortfolioChangesFromLibrary } from "../backtest/portfolio/portfolioLibrarySuggestions.js";
import { listPortfolioTickers, parsePortfolioBookRequest, simulatePortfolio } from "../backtest/portfolio/portfolioSimulatorStore.js";
import { BacktestRequestError, queuePortfolioLibraryJob } from "../backtest/jobs/backtestJobStore.js";
import { createSavedPortfolio, deleteSavedPortfolio, listSavedPortfolios, parseSavedPortfolioInput, updateSavedPortfolio } from "../backtest/portfolio/savedPortfolioStore.js";

// The portfolio simulator's routes (under /backtest, the lab only): every analysed ticker for the book's picker, how a
// book's tickers move together, its pot table and suggested allocations, its projection streamed over SSE (minutes: every
// path is the book run through v4's own days), its one-change suggestions streamed over SSE (on the library at once, then
// the best confirmed exactly), the suggestions' library: its state and a rebuild, and the saved portfolios.

const streamHeartbeatMs = 15_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function portfolioIdOf(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new BacktestRequestError("No such portfolio.", 404);
  return value;
}

/** The request as JSON in ?book= (EventSource sends no body), parsed; a 400 with the message when it isn't one. */
function parseQueryBook<Parsed>(query: unknown, response: Response, parse: (body: unknown) => Parsed): Parsed | null {
  try {
    return parse(JSON.parse(typeof query === "string" ? query : "null"));
  } catch (error) {
    response.status(400).json({ error: error instanceof SyntaxError ? "book must be the book as JSON." : error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Runs `work` behind an event stream: "progress" {done, total, label} at most every 250 ms and at the end, any events the
 * work sends itself (`send`), then "result" or "failure". `signal` aborts when the client closes the stream before the end,
 * so a projection's workers stop with it.
 */
async function streamWork<Result>(response: Response, work: (onProgress: (done: number, total: number, label?: string) => void, send: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<Result>): Promise<void> {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});
  const stopped = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) stopped.abort();
  });
  const send = (event: string, data: unknown) => {
    if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, streamHeartbeatMs);
  try {
    let lastSent = 0;
    const result = await work((done, total, label) => {
      if (done === total || Date.now() - lastSent > 250) {
        lastSent = Date.now();
        send("progress", label === undefined ? { done, total } : { done, total, label });
      }
    }, send, stopped.signal);
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
    if (book !== null) await streamWork(response, (onProgress, _send, signal) => projectPortfolio(book, onProgress, undefined, signal));
  });

  // The book as JSON in ?book=. "suggestions" events carry the list so far: on the library, then after each exact projection.
  router.get("/portfolio/suggestions/stream", async (request, response) => {
    const book = parseQueryBook(request.query.book, response, parsePortfolioBookRequest);
    if (book !== null) await streamWork(response, (onProgress, send, signal) => suggestPortfolioChangesFromLibrary(book, { onProgress, onSuggestions: (suggestions) => send("suggestions", suggestions), signal }));
  });

  router.get("/portfolio/library", async (_request, response) => {
    response.json(await portfolioLibraryStatus());
  });

  // Queues a rebuild (one at a time; it waits for the downloads).
  router.post("/portfolio/library/rebuild", async (_request, response) => {
    response.status(202).json({ jobId: await queuePortfolioLibraryJob() });
  });

  router.get("/portfolio/portfolios", async (_request, response) => {
    response.json({ portfolios: await listSavedPortfolios() });
  });

  // {name, tickers, accountDollars}: Save as, or the first Save of a new portfolio.
  router.post("/portfolio/portfolios", async (request, response) => {
    response.status(201).json(await createSavedPortfolio(parseSavedPortfolioInput(request.body)));
  });

  router.put("/portfolio/portfolios/:id", async (request, response) => {
    response.json(await updateSavedPortfolio(portfolioIdOf(request.params.id), parseSavedPortfolioInput(request.body)));
  });

  router.delete("/portfolio/portfolios/:id", async (request, response) => {
    await deleteSavedPortfolio(portfolioIdOf(request.params.id));
    response.status(204).end();
  });
}
