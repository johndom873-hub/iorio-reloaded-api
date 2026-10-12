import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { normalizeBacktestSymbol, requireBacktestDataDirectory } from "../backtest/backtestDataDirectory.js";
import type { BacktestOverview } from "../backtest/backtestTypes.js";
import { readBacktestDataFileContents, summarizeBacktestDataFiles } from "../backtest/dataFileSummary.js";
import { backtestHistoryStartDate } from "../backtest/backfillDailyHistory.js";
import { editableBacktestSettingPaths, loadBacktestSettingsTemplate, loadCurrentBacktestSettings } from "../backtest/settingsTemplate.js";
import { defaultDownloadStartDate, isIsoCalendarDate, lastFinishedBacktestSessionDate } from "../backtest/jobs/backtestJobRules.js";
import {
  BacktestRequestError,
  cancelBacktestJob,
  createDownloadJob,
  findUnfinishedDownloadJob,
  kickDownloadQueue,
  listOverviewJobViews,
  resumeBacktestJob,
} from "../backtest/jobs/backtestJobStore.js";
import { validateCreateBacktestSessionRequest } from "../backtest/jobs/backtestSessionRequest.js";
import { createBacktestSession, deleteBacktestSession, listBacktestSessionItems, loadBacktestComparison, loadBacktestSessionDetail } from "../backtest/jobs/backtestSessionStore.js";

// Model backtesting (docs/backtesting/), local only: app.ts mounts this router only when BACKTEST_DATA_DIR is set.
// Shapes are backtestTypes.ts, which the app mirrors.

export const backtestRouter = Router();
backtestRouter.use(requireAuth);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuidParameter(value: string | undefined, what: string): string {
  if (!value || !uuidPattern.test(value)) throw new BacktestRequestError(`No such ${what}.`, 404);
  return value;
}

backtestRouter.get("/overview", async (_request, response) => {
  // Reading the overview is one of the moments the download queue moves on (a stopped download no longer blocks it).
  await kickDownloadQueue();
  const [files, jobs, sessions] = await Promise.all([summarizeBacktestDataFiles(), listOverviewJobViews(), listBacktestSessionItems()]);
  const overview: BacktestOverview = { dataDirectory: requireBacktestDataDirectory(), files, jobs, sessions };
  response.json(overview);
});

backtestRouter.post("/downloads", async (request, response) => {
  const body = (request.body ?? {}) as { symbol?: unknown; startDate?: unknown };
  let symbol: string;
  try {
    symbol = normalizeBacktestSymbol(typeof body.symbol === "string" ? body.symbol : "");
  } catch (error) {
    throw new BacktestRequestError(error instanceof Error ? error.message : String(error), 400);
  }
  const startDate = body.startDate === undefined || body.startDate === null || body.startDate === "" ? defaultDownloadStartDate : body.startDate;
  if (!isIsoCalendarDate(startDate)) throw new BacktestRequestError("startDate must be a date (YYYY-MM-DD).", 400);
  // The IBKR daily bars a session needs (forecast, settlement) reach back to this date only.
  if (startDate < backtestHistoryStartDate) throw new BacktestRequestError(`The start date must be on or after ${backtestHistoryStartDate}: the IBKR daily history starts there.`, 400);
  const endDate = lastFinishedBacktestSessionDate(new Date());
  if (startDate > endDate) throw new BacktestRequestError(`The start date must be on or before the last finished session (${endDate}).`, 400);
  if (await findUnfinishedDownloadJob(symbol)) throw new BacktestRequestError(`${symbol} already has a download queued or running: resume or cancel that one.`, 409);
  response.status(201).json(await createDownloadJob({ symbol, startDate, endDate }));
});

backtestRouter.post("/jobs/:id/cancel", async (request, response) => {
  response.json(await cancelBacktestJob(requireUuidParameter(request.params.id, "job")));
});

backtestRouter.post("/jobs/:id/resume", async (request, response) => {
  response.json(await resumeBacktestJob(requireUuidParameter(request.params.id, "job")));
});

backtestRouter.get("/settings-template", async (_request, response) => {
  response.json(await loadBacktestSettingsTemplate());
});

backtestRouter.post("/sessions", async (request, response) => {
  const snapshot = await loadCurrentBacktestSettings();
  const validation = validateCreateBacktestSessionRequest(request.body, {
    snapshot,
    editablePaths: editableBacktestSettingPaths,
    coverageFor: (symbol) => readBacktestDataFileContents(symbol),
  });
  if (!validation.ok) throw new BacktestRequestError(validation.error, 400);
  response.status(201).json(await createBacktestSession(validation.value, snapshot));
});

backtestRouter.get("/sessions/:id", async (request, response) => {
  response.json(await loadBacktestSessionDetail(requireUuidParameter(request.params.id, "session")));
});

backtestRouter.get("/compare", async (request, response) => {
  const ids = [...new Set(String(request.query.ids ?? "").split(",").map((id) => id.trim()).filter((id) => id !== ""))];
  if (ids.length === 0) throw new BacktestRequestError("Pass the session ids to compare: ?ids=a,b", 400);
  const malformed = ids.find((id) => !uuidPattern.test(id));
  if (malformed) throw new BacktestRequestError(`Not a session id: "${malformed}"`, 400);
  response.json(await loadBacktestComparison(ids));
});

backtestRouter.delete("/sessions/:id", async (request, response) => {
  await deleteBacktestSession(requireUuidParameter(request.params.id, "session"));
  response.status(204).end();
});

// A request the job or session state does not allow is answered with its own status and message; anything else goes on
// to the app's error handler.
backtestRouter.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
  if (error instanceof BacktestRequestError) {
    response.status(error.httpStatus).json({ error: error.message });
    return;
  }
  next(error);
});
