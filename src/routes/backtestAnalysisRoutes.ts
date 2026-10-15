import type { Router } from "express";
import { db } from "../db/connection.js";
import { captureHistoricalEarnings } from "../lib/apiNinjasEarningsService.js";
import { normalizeBacktestSymbol } from "../backtest/backtestDataDirectory.js";
import { BacktestRequestError } from "../backtest/jobs/backtestJobStore.js";
import { listAnalysisSessions } from "../backtest/analysis/analysisSessions.js";
import {
  cancelTickerAnalysis,
  loadAnalysisStatusBySymbol,
  loadTickerAnalysisRun,
  loadTickerAnalysisView,
  listTickerAnalysisRuns,
  startTickerAnalysis,
  validateAnalysisTrialValues,
} from "../backtest/analysis/analysisStore.js";

// The Analyse window's routes (under /backtest): the stored analysis, starting one (Update Analysis, or Run with these
// values when the body has values), cancelling it, its history, the ticker's backtests, and fetching its earnings.

const symbolParameter = (raw: unknown): string => {
  try {
    return normalizeBacktestSymbol(typeof raw === "string" ? raw : "");
  } catch (error) {
    throw new BacktestRequestError(error instanceof Error ? error.message : String(error), 400);
  }
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerTickerAnalysisRoutes(router: Router): void {
  // Each data file's latest saved analysis: the Data files table's Analyse column.
  router.get("/analyses", async (_request, response) => {
    response.json(Object.fromEntries(await loadAnalysisStatusBySymbol()));
  });

  router.get("/analyses/runs/:id", async (request, response) => {
    if (!uuidPattern.test(String(request.params.id))) throw new BacktestRequestError("No such analysis.", 404);
    response.json(await loadTickerAnalysisRun(String(request.params.id)));
  });

  router.post("/analyses/runs/:id/cancel", async (request, response) => {
    if (!uuidPattern.test(String(request.params.id))) throw new BacktestRequestError("No such analysis.", 404);
    response.json(await cancelTickerAnalysis(String(request.params.id)));
  });

  router.get("/analyses/:symbol", async (request, response) => {
    response.json(await loadTickerAnalysisView(symbolParameter(request.params.symbol)));
  });

  router.get("/analyses/:symbol/runs", async (request, response) => {
    response.json(await listTickerAnalysisRuns(symbolParameter(request.params.symbol)));
  });

  router.get("/analyses/:symbol/sessions", async (request, response) => {
    response.json(await listAnalysisSessions(symbolParameter(request.params.symbol)));
  });

  // Body: {} for Update Analysis; { values: { … } } for Run with these values (nothing saved).
  router.post("/analyses/:symbol", async (request, response) => {
    const symbol = symbolParameter(request.params.symbol);
    const body = (request.body ?? {}) as { values?: unknown };
    const trial = body.values === undefined ? null : validateAnalysisTrialValues(body.values);
    const started = await startTickerAnalysis({ symbol, reason: trial === null ? "manual" : "trial", trial });
    response.status(202).json(await loadTickerAnalysisRun(started.analysisId));
  });

  // Fetches the ticker's earnings history (API Ninjas), then updates the analysis: its backtest is reused when nothing
  // else changed, so the earnings figures and the summary are what change.
  router.post("/analyses/:symbol/fetch-earnings", async (request, response) => {
    const symbol = symbolParameter(request.params.symbol);
    const ticker: { id: string } | undefined = await db("tickers").where({ symbol }).first("id");
    if (!ticker) throw new BacktestRequestError(`${symbol} has no ticker row: its download creates it.`, 409);
    const capture = await captureHistoricalEarnings(ticker.id, symbol);
    if (capture.error) throw new BacktestRequestError(`API Ninjas could not be read: ${capture.error}`, 409);
    if (capture.skippedEtf) throw new BacktestRequestError(`${symbol} is an ETF: ETFs do not report earnings.`, 409);
    const started = await startTickerAnalysis({ symbol, reason: "manual" });
    response.status(202).json({ written: capture.written, run: await loadTickerAnalysisRun(started.analysisId) });
  });
}
