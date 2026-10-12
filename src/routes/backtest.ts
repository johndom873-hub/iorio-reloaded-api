import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { normalizeBacktestSymbol, requireBacktestDataDirectory } from "../backtest/backtestDataDirectory.js";
import type { BacktestOverview } from "../backtest/backtestTypes.js";
import { readBacktestDataFileContents, readBacktestDataFilePeriodContents, summarizeBacktestDataFiles } from "../backtest/dataFileSummary.js";
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
import { validateBacktestBookPageQuery, validateCreateBacktestSessionRequest } from "../backtest/jobs/backtestSessionRequest.js";
import { readBacktestClaudeCliPath } from "../backtest/backtestClaudeCli.js";
import { applyBacktestOverrides } from "../backtest/backtestSettingsOverrides.js";
import { lookTimesInWindow, regularCloseMinutesEt } from "../backtest/engine/runBacktestSession.js";
import { estimateLlmSession } from "../backtest/llm/estimateLlmSession.js";
import { createBacktestSession, deleteBacktestSession, listBacktestSessionItems, loadBacktestComparison, loadBacktestSessionActions, loadBacktestSessionDetail, loadBacktestSessionFills } from "../backtest/jobs/backtestSessionStore.js";

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

/** A New session request checked as the create route checks it, with the AI model's estimate when it decides (null on the rules). */
async function validateSessionRequestWithEstimate(body: unknown) {
  const snapshot = await loadCurrentBacktestSettings();
  const validation = validateCreateBacktestSessionRequest(body, {
    snapshot,
    editablePaths: editableBacktestSettingPaths,
    coverageFor: (symbol) => readBacktestDataFileContents(symbol),
    periodContentsFor: (symbol, startDate, endDate) => readBacktestDataFilePeriodContents(symbol, startDate, endDate),
    claudeCliAvailable: readBacktestClaudeCliPath() !== null,
  });
  if (!validation.ok) throw new BacktestRequestError(validation.error, 400);
  // With the AI model deciding, the calls a full day of looks may take (a day without intraday quotes has one look).
  const effective = applyBacktestOverrides(snapshot, validation.value.overrides);
  const llmEstimate =
    effective.decisionMaker === "llm"
      ? estimateLlmSession(validation.value.startDate, validation.value.endDate, lookTimesInWindow(effective.pluto.windowStartEt, effective.pluto.windowEndEt, regularCloseMinutesEt).length)
      : null;
  return { snapshot, value: validation.value, warnings: validation.warnings, llmEstimate };
}

backtestRouter.post("/sessions", async (request, response) => {
  const { snapshot, value, warnings, llmEstimate } = await validateSessionRequestWithEstimate(request.body);
  response.status(201).json({ ...(await createBacktestSession(value, snapshot)), warnings, llmEstimate });
});

// The New session screen's estimate before anything starts: the same request body, checked the same way (a name is not
// needed yet), nothing created.
backtestRouter.post("/sessions/estimate", async (request, response) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const { warnings, llmEstimate } = await validateSessionRequestWithEstimate({ ...body, name: typeof body.name === "string" && body.name.trim() !== "" ? body.name : "estimate" });
  response.json({ warnings, llmEstimate });
});

// ?symbol=XYZ narrows the option sales, positions, cycles and statistics to one symbol of the session's book.
backtestRouter.get("/sessions/:id", async (request, response) => {
  let onlySymbol: string | null = null;
  if (typeof request.query.symbol === "string" && request.query.symbol.trim() !== "") {
    try {
      onlySymbol = normalizeBacktestSymbol(request.query.symbol);
    } catch (error) {
      throw new BacktestRequestError(error instanceof Error ? error.message : String(error), 400);
    }
  }
  response.json(await loadBacktestSessionDetail(requireUuidParameter(request.params.id, "session"), onlySymbol));
});

// A session's actions (taken and refused) and fills grow with every look, so they are read page by page, filtered by
// trading date and symbol (BacktestBookPageQuery).
backtestRouter.get("/sessions/:id/actions", async (request, response) => {
  const validation = validateBacktestBookPageQuery(request.query as Record<string, unknown>, { outcomeAllowed: true });
  if (!validation.ok) throw new BacktestRequestError(validation.error, 400);
  response.json(await loadBacktestSessionActions(requireUuidParameter(request.params.id, "session"), validation.filters));
});

backtestRouter.get("/sessions/:id/fills", async (request, response) => {
  const validation = validateBacktestBookPageQuery(request.query as Record<string, unknown>, { outcomeAllowed: false });
  if (!validation.ok) throw new BacktestRequestError(validation.error, 400);
  response.json(await loadBacktestSessionFills(requireUuidParameter(request.params.id, "session"), validation.filters));
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
