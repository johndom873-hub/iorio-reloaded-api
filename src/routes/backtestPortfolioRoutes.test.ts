import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The portfolio simulator's routes on their own router: the request's checks (400s), how the book moves together, its pot
// table, the projection's and suggestions' event streams, and the suggestions' library. The store's database work is mocked;
// its request parsing is the real one.
const simulatePortfolioMock = vi.fn();
const suggestionsMock = vi.fn();
vi.mock("../backtest/portfolio/portfolioLibrarySuggestions.js", () => ({ suggestPortfolioChangesFromLibrary: (...args: unknown[]) => suggestionsMock(...args) }));
const libraryStatusMock = vi.fn();
vi.mock("../backtest/portfolio/portfolioLibraryStatus.js", () => ({ portfolioLibraryStatus: (...args: unknown[]) => libraryStatusMock(...args) }));
const queueLibraryMock = vi.fn();
vi.mock("../backtest/jobs/backtestJobStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backtest/jobs/backtestJobStore.js")>()),
  queuePortfolioLibraryJob: (...args: unknown[]) => queueLibraryMock(...args),
}));
vi.mock("../backtest/portfolio/portfolioSimulatorStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backtest/portfolio/portfolioSimulatorStore.js")>()),
  listPortfolioTickers: async () => [{ symbol: "XLE", verdict: "suits", sector: "Energy", analysedAt: "2026-11-02T07:14:07.000Z" }],
  simulatePortfolio: (...args: unknown[]) => simulatePortfolioMock(...args),
}));

const projectPortfolioMock = vi.fn();
const portfolioPotsMock = vi.fn();
vi.mock("../backtest/portfolio/portfolioProjectionStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backtest/portfolio/portfolioProjectionStore.js")>()),
  projectPortfolio: (...args: unknown[]) => projectPortfolioMock(...args),
  portfolioPots: (...args: unknown[]) => portfolioPotsMock(...args),
}));

const savedPortfolioMocks = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() };
vi.mock("../backtest/portfolio/savedPortfolioStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backtest/portfolio/savedPortfolioStore.js")>()),
  listSavedPortfolios: (...args: unknown[]) => savedPortfolioMocks.list(...args),
  createSavedPortfolio: (...args: unknown[]) => savedPortfolioMocks.create(...args),
  updateSavedPortfolio: (...args: unknown[]) => savedPortfolioMocks.update(...args),
  deleteSavedPortfolio: (...args: unknown[]) => savedPortfolioMocks.remove(...args),
}));

const { registerPortfolioSimulatorRoutes } = await import("./backtestPortfolioRoutes.js");
const { BacktestRequestError } = await import("../backtest/jobs/backtestJobStore.js");
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const router = Router();
  registerPortfolioSimulatorRoutes(router);
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof BacktestRequestError) response.status(error.httpStatus).json({ error: error.message });
    else next(error);
  });
  const app = express();
  app.use(express.json());
  app.use("/backtest", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (route: string, body: unknown) => fetch(`${baseUrl}/backtest${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("portfolio simulator routes", () => {
  it("lists every analysed ticker", async () => {
    const response = await fetch(`${baseUrl}/backtest/portfolio/tickers`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { tickers: { symbol: string }[] }).tickers[0]?.symbol).toBe("XLE");
  });

  it("refuses a book it can't read", async () => {
    for (const body of [{}, { tickers: [], accountDollars: 1 }, { tickers: [{ symbol: "XLE" }], accountDollars: 0 }, { tickers: [{ symbol: "XLE", allocationPct: 120 }], accountDollars: 1 }, { tickers: [{ symbol: "XLE" }, { symbol: "XLE" }], accountDollars: 1 }, { tickers: [{ symbol: "XLE" }], accountDollars: 1, horizonYears: 4 }]) {
      const response = await post("/portfolio/simulate", body);
      expect(response.status).toBe(400);
    }
    expect(simulatePortfolioMock).not.toHaveBeenCalled();
  });

  it("answers a book with how it moves together, empty allocations as equal shares and 5 years by default", async () => {
    simulatePortfolioMock.mockResolvedValueOnce({ asOf: "2026-10-30" });
    const response = await post("/portfolio/simulate", { tickers: [{ symbol: "XLE" }, { symbol: "NVDA", allocationPct: 40 }], accountDollars: 3_500_000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ asOf: "2026-10-30" });
    expect(simulatePortfolioMock).toHaveBeenCalledWith({ tickers: [{ symbol: "XLE", allocationPct: null }, { symbol: "NVDA", allocationPct: 40 }], accountDollars: 3_500_000, horizonYears: 5 });
  });

  it("streams the suggestions' progress, each list so far, then the result", async () => {
    suggestionsMock.mockImplementationOnce(async (_book: unknown, hooks: { onProgress: (done: number, total: number, label: string) => void; onSuggestions: (suggestions: unknown) => void }) => {
      hooks.onProgress(1, 2, "Scoring the changes on the library");
      hooks.onSuggestions({ book: { excessCalmar: 0.2 }, suggestions: [] });
      hooks.onProgress(2, 2, "Done");
      return { book: { excessCalmar: 0.2 }, bookExact: { excessCalmar: 0.21 }, suggestions: [] };
    });
    const book = encodeURIComponent(JSON.stringify({ tickers: [{ symbol: "XLE" }], accountDollars: 1_000_000, horizonYears: 3 }));
    const response = await fetch(`${baseUrl}/backtest/portfolio/suggestions/stream?book=${book}`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: progress");
    expect(text).toContain('"done":2,"total":2,"label":"Done"');
    expect(text).toContain('event: suggestions\ndata: {"book":{"excessCalmar":0.2},"suggestions":[]}');
    expect(text).toContain('event: result\ndata: {"book":{"excessCalmar":0.2},"bookExact":{"excessCalmar":0.21},"suggestions":[]}');
  });

  it("gives the library's state and queues a rebuild", async () => {
    libraryStatusMock.mockResolvedValueOnce({ built: null, current: null, updatedSince: [], rebuild: null });
    const status = await fetch(`${baseUrl}/backtest/portfolio/library`);
    expect(await status.json()).toEqual({ built: null, current: null, updatedSince: [], rebuild: null });
    queueLibraryMock.mockResolvedValueOnce("job-1");
    const rebuild = await fetch(`${baseUrl}/backtest/portfolio/library/rebuild`, { method: "POST" });
    expect(rebuild.status).toBe(202);
    expect(await rebuild.json()).toEqual({ jobId: "job-1" });
  });

  it("refuses a suggestions stream without a book", async () => {
    expect((await fetch(`${baseUrl}/backtest/portfolio/suggestions/stream?book=nope`)).status).toBe(400);
  });

  it("answers a book's pot table", async () => {
    portfolioPotsMock.mockResolvedValueOnce({ asOf: "2026-10-30", pots: [] });
    const response = await post("/portfolio/pots", { tickers: [{ symbol: "XLE" }], accountDollars: 1_000_000 });
    expect(response.status).toBe(200);
    expect(portfolioPotsMock).toHaveBeenCalledWith({ tickers: [{ symbol: "XLE", allocationPct: null }], accountDollars: 1_000_000, horizonYears: 5 });
  });

  it("refuses a projection with a path count outside 1 to 2,000 or with another drift, before any work", async () => {
    for (const extra of [{ pathCount: 0 }, { pathCount: 2001 }, { pathCount: 2.5 }, { pathCount: 10, drift: "bullish" }]) {
      const book = encodeURIComponent(JSON.stringify({ tickers: [{ symbol: "XLE" }], accountDollars: 1_000_000, ...extra }));
      const response = await fetch(`${baseUrl}/backtest/portfolio/projection/stream?book=${book}`);
      expect(response.status).toBe(400);
    }
    expect(projectPortfolioMock).not.toHaveBeenCalled();
  });

  it("streams the projection's progress, then its result, neutral with 500 paths by default", async () => {
    projectPortfolioMock.mockImplementationOnce(async (_book: unknown, onProgress: (done: number, total: number) => void) => {
      onProgress(4, 4);
      return { asOf: "2026-10-30" };
    });
    const book = encodeURIComponent(JSON.stringify({ tickers: [{ symbol: "XLE" }], accountDollars: 1_000_000 }));
    const text = await (await fetch(`${baseUrl}/backtest/portfolio/projection/stream?book=${book}`)).text();
    expect(text).toContain('"done":4,"total":4');
    expect(text).toContain('event: result\ndata: {"asOf":"2026-10-30"}');
    expect(projectPortfolioMock.mock.calls[0]![0]).toMatchObject({ drift: "neutral", pathCount: 500, horizonYears: 5 });
  });

  it("streams a failure when the projection fails", async () => {
    projectPortfolioMock.mockRejectedValueOnce(new Error("XLE: no data file."));
    const book = encodeURIComponent(JSON.stringify({ tickers: [{ symbol: "XLE" }], accountDollars: 1_000_000, pathCount: 4 }));
    const text = await (await fetch(`${baseUrl}/backtest/portfolio/projection/stream?book=${book}`)).text();
    expect(text).toContain('event: failure\ndata: {"error":"XLE: no data file."}');
  });
});

describe("saved portfolio routes", () => {
  const portfolioId = "0b9a3c1e-5f0d-4c2b-9a51-3d2f6e7a8b90";
  const send = (method: string, route: string, body?: unknown) => fetch(`${baseUrl}/backtest${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("lists, creates (201), saves over and deletes (204) with the request checked", async () => {
    savedPortfolioMocks.list.mockResolvedValueOnce([{ id: portfolioId, name: "Fits $1M" }]);
    expect(await (await send("GET", "/portfolio/portfolios")).json()).toEqual({ portfolios: [{ id: portfolioId, name: "Fits $1M" }] });
    savedPortfolioMocks.create.mockResolvedValueOnce({ id: portfolioId });
    const created = await send("POST", "/portfolio/portfolios", { name: " Fits $1M ", tickers: [{ symbol: "XLE" }], accountDollars: 1_000_000 });
    expect(created.status).toBe(201);
    expect(savedPortfolioMocks.create).toHaveBeenCalledWith({ name: "Fits $1M", tickers: [{ symbol: "XLE", allocationPct: null }], accountDollars: 1_000_000 });
    savedPortfolioMocks.update.mockResolvedValueOnce({ id: portfolioId });
    expect((await send("PUT", `/portfolio/portfolios/${portfolioId}`, { name: "B", tickers: [], accountDollars: 5 })).status).toBe(200);
    expect(savedPortfolioMocks.update).toHaveBeenCalledWith(portfolioId, { name: "B", tickers: [], accountDollars: 5 });
    savedPortfolioMocks.remove.mockResolvedValueOnce(undefined);
    expect((await send("DELETE", `/portfolio/portfolios/${portfolioId}`)).status).toBe(204);
  });

  it("answers 400 for a bad request, 404 for an id that isn't one and passes the store's 409 on", async () => {
    expect((await send("POST", "/portfolio/portfolios", { name: "", tickers: [], accountDollars: 1 })).status).toBe(400);
    expect((await send("PUT", "/portfolio/portfolios/not-an-id", { name: "A", tickers: [], accountDollars: 1 })).status).toBe(404);
    expect((await send("DELETE", "/portfolio/portfolios/not-an-id")).status).toBe(404);
    savedPortfolioMocks.create.mockRejectedValueOnce(new BacktestRequestError('A portfolio named "A" already exists. Choose another name.', 409));
    const duplicate = await send("POST", "/portfolio/portfolios", { name: "A", tickers: [], accountDollars: 1 });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'A portfolio named "A" already exists. Choose another name.' });
  });
});
