import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The portfolio simulator's routes on their own router: the request's checks (400s), how the book moves together, its pot
// table, and the projection's and suggestions' event streams. The store's database work is mocked; its request parsing is the real one.
const simulatePortfolioMock = vi.fn();
const suggestPortfolioChangesMock = vi.fn();
vi.mock("../backtest/portfolio/portfolioSimulatorStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backtest/portfolio/portfolioSimulatorStore.js")>()),
  listPortfolioTickers: async () => [{ symbol: "XLE", verdict: "suits", sector: "Energy", analysedAt: "2026-11-02T07:14:07.000Z" }],
  simulatePortfolio: (...args: unknown[]) => simulatePortfolioMock(...args),
  suggestPortfolioChanges: (...args: unknown[]) => suggestPortfolioChangesMock(...args),
}));

const projectPortfolioMock = vi.fn();
const portfolioPotsMock = vi.fn();
vi.mock("../backtest/portfolio/portfolioProjectionStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backtest/portfolio/portfolioProjectionStore.js")>()),
  projectPortfolio: (...args: unknown[]) => projectPortfolioMock(...args),
  portfolioPots: (...args: unknown[]) => portfolioPotsMock(...args),
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

  it("answers a book with its projection, empty allocations as equal shares and 5 years by default", async () => {
    simulatePortfolioMock.mockResolvedValueOnce({ asOf: "2026-10-30" });
    const response = await post("/portfolio/simulate", { tickers: [{ symbol: "XLE" }, { symbol: "NVDA", allocationPct: 40 }], accountDollars: 3_500_000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ asOf: "2026-10-30" });
    expect(simulatePortfolioMock).toHaveBeenCalledWith({ tickers: [{ symbol: "XLE", allocationPct: null }, { symbol: "NVDA", allocationPct: 40 }], accountDollars: 3_500_000, horizonYears: 5, callDaysPace: "today" });
  });

  it("streams the suggestions' progress, then the result", async () => {
    suggestPortfolioChangesMock.mockImplementationOnce(async (_book: unknown, onProgress: (done: number, total: number) => void) => {
      onProgress(1, 2);
      onProgress(2, 2);
      return { baseline: { excessCalmar: 1, cagr: 0.2, maxDrawdown: -0.2 }, suggestions: [] };
    });
    const book = encodeURIComponent(JSON.stringify({ tickers: [{ symbol: "XLE" }], accountDollars: 1_000_000, horizonYears: 3 }));
    const response = await fetch(`${baseUrl}/backtest/portfolio/suggestions/stream?book=${book}`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: progress");
    expect(text).toContain('"done":2,"total":2');
    expect(text).toContain("event: result");
  });

  it("refuses a suggestions stream without a book", async () => {
    expect((await fetch(`${baseUrl}/backtest/portfolio/suggestions/stream?book=nope`)).status).toBe(400);
  });

  it("answers a book's pot table", async () => {
    portfolioPotsMock.mockResolvedValueOnce({ asOf: "2026-10-30", pots: [] });
    const response = await post("/portfolio/pots", { tickers: [{ symbol: "XLE" }], accountDollars: 1_000_000 });
    expect(response.status).toBe(200);
    expect(portfolioPotsMock).toHaveBeenCalledWith({ tickers: [{ symbol: "XLE", allocationPct: null }], accountDollars: 1_000_000, horizonYears: 5, callDaysPace: "today" });
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
