import type { Router } from "express";
import { db } from "../db/connection.js";
import { captureHistoricalEarnings } from "../lib/apiNinjasEarningsService.js";
import { normalizeBacktestSymbol } from "../backtest/backtestDataDirectory.js";
import { BacktestRequestError } from "../backtest/jobs/backtestJobStore.js";
import { listAnalysisSessions } from "../backtest/analysis/analysisSessions.js";
import { BacktestLabSettingsValidationError } from "../backtest/labSettingsStore.js";
import { loadTickerOwnValuesOverview, saveTickerOwnValues } from "../backtest/labTickerValuesStore.js";
import {
  assertTickerCanBeAnalysed,
  cancelTickerAnalysis,
  loadAnalysesForTable,
  loadAnalysisFileFigures,
  loadTickerAnalysisRun,
  loadTickerAnalysisView,
  listTickerAnalysisRuns,
  rerunOutOfDateAnalyses,
  startTickerAnalysis,
  validateAnalysisTrialValues,
} from "../backtest/analysis/analysisStore.js";

// The Analyse window's routes (under /backtest): the stored analysis, the data file's figures before a first analysis,
// starting one (Re-run analysis, or Run a trial when the body has a starting account), cancelling it, its history, the
// ticker's backtests, fetching its earnings, the Data files table's Re-run out of date, and the tickers' own Vol Farmer
// v4 values (Save and Analyse).

const symbolParameter = (raw: unknown): string => {
  try {
    return normalizeBacktestSymbol(typeof raw === "string" ? raw : "");
  } catch (error) {
    throw new BacktestRequestError(error instanceof Error ? error.message : String(error), 400);
  }
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerTickerAnalysisRoutes(router: Router): void {
  // Every ticker's own Vol Farmer v4 values and the lab's five now (New session prefills a session of one such ticker).
  router.get("/ticker-values", async (_request, response) => {
    response.json(await loadTickerOwnValuesOverview());
  });

  // Save and Analyse. Body: some of { callMinAbsDelta, callMaxAbsDelta, firstPositionPct, putMaxAbsDelta,
  // leapsMaxAccountPct }, each a number or null for the lab's value. Saves them, then starts the ticker's analysis with
  // them; refused, nothing saved, while it cannot be analysed (no data file, its download or a saved analysis running).
  router.put("/ticker-values/:symbol", async (request, response) => {
    const symbol = await assertTickerCanBeAnalysed(symbolParameter(request.params.symbol), "saved");
    let saved: Awaited<ReturnType<typeof saveTickerOwnValues>>;
    try {
      saved = await saveTickerOwnValues(symbol, request.body ?? {}, request.session.userId ?? null);
    } catch (error) {
      if (error instanceof BacktestLabSettingsValidationError) throw new BacktestRequestError(error.message, 400);
      throw error;
    }
    const started = await startTickerAnalysis({ symbol, reason: "ticker_settings" });
    response.json({ tickerValues: saved.saved, changes: saved.changes, run: await loadTickerAnalysisRun(started.analysisId) });
  });

  // Each data file's latest saved analysis, its Vol Farmer v4 figures and whether it is out of date: the Data files table's columns.
  router.get("/analyses", async (_request, response) => {
    response.json(await loadAnalysesForTable());
  });

  // Starts a saved analysis of every ticker whose stored one is out of date.
  router.post("/analyses/rerun-out-of-date", async (_request, response) => {
    response.status(202).json(await rerunOutOfDateAnalyses());
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

  // The figures the data file gives on its own (no chain scan, nothing stored): the window before a ticker's first analysis.
  router.get("/analyses/:symbol/file-figures", async (request, response) => {
    response.json(await loadAnalysisFileFigures(symbolParameter(request.params.symbol)));
  });

  router.get("/analyses/:symbol/runs", async (request, response) => {
    response.json(await listTickerAnalysisRuns(symbolParameter(request.params.symbol)));
  });

  router.get("/analyses/:symbol/sessions", async (request, response) => {
    response.json(await listAnalysisSessions(symbolParameter(request.params.symbol)));
  });

  // Body: {} for Re-run analysis; { values: { accountDollars } } for Run a trial (nothing saved as the ticker's analysis).
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
