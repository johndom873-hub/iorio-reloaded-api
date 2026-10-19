import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAdmin, requireAuth } from "../middleware/requireAuth.js";
import { normalizeBacktestSymbol, requireBacktestDataDirectory } from "../backtest/backtestDataDirectory.js";
import type { BacktestLabSettingsView, BacktestOverview, BacktestSessionEstimateResponse, BacktestSettingsTemplate, CreateBacktestBatchResponse } from "../backtest/backtestTypes.js";
import { listBacktestDataFileSymbols, readBacktestDataFileContents, readBacktestDataFilePeriodContents, summarizeBacktestDataFiles } from "../backtest/dataFileSummary.js";
import { loadTickerSuitabilityBySymbol, saveTickerSuitability, tickerSuitabilityNoteMaxLength, tickerSuitabilityMarks } from "../backtest/tickerSuitabilityStore.js";
import { deleteBacktestDataFile } from "../backtest/deleteBacktestDataFile.js";
import { backtestHistoryStartDate } from "../backtest/backfillDailyHistory.js";
import { backtestNotReplayed, buildBacktestSettingRows, editableBacktestSettingPaths } from "../backtest/settingsTemplate.js";
import {
  BacktestLabSettingsValidationError,
  analysisReadsLabPath,
  globalChangeReachesTicker,
  loadBacktestLabAudit,
  loadBacktestLabSettings,
  loadBacktestLabTickerOverrides,
  noteLabAuditAnalysesRerun,
  saveBacktestLabTickerOverrides,
  tickerOverridesGlobalPath,
  updateBacktestLabSettings,
  type BacktestLabSettings,
} from "../backtest/labSettingsStore.js";
import { defaultDownloadStartDate, isIsoCalendarDate, lastFinishedBacktestSessionDate } from "../backtest/jobs/backtestJobRules.js";
import {
  BacktestRequestError,
  cancelBacktestJob,
  createDownloadJob,
  putDownloadFirst,
  findUnfinishedDownloadJob,
  kickBacktestQueue,
  kickDownloadQueue,
  readBacktestMaxParallelSessions,
  listOverviewJobViews,
  resumeBacktestJob,
} from "../backtest/jobs/backtestJobStore.js";
import { validateBacktestBookPageQuery, validateBacktestSessionsPageQuery } from "../backtest/jobs/backtestSessionRequest.js";
import { checkSessionRequestAgainstLab, validateBatchRequestAgainstLab, validateSessionRequestAgainstLab } from "../backtest/jobs/labSessionRequest.js";
import { registerTickerAnalysisRoutes } from "./backtestAnalysisRoutes.js";
import { listAnalysedSymbols, rerunAnalysesAfterSave } from "../backtest/analysis/analysisStore.js";
import { readBacktestClaudeCliPath } from "../backtest/backtestClaudeCli.js";
import { applyBacktestOverrides } from "../backtest/backtestSettingsOverrides.js";
import { lookTimesInWindow, regularCloseMinutesEt } from "../backtest/engine/runBacktestSession.js";
import { estimateLlmSession } from "../backtest/llm/estimateLlmSession.js";
import {
  createBacktestBatch,
  createBacktestSession,
  deleteBacktestBatch,
  deleteBacktestSession,
  loadBacktestBatchCombined,
  loadBacktestBatchDetail,
  loadBacktestComparison,
  loadBacktestSessionActions,
  loadBacktestSessionDetail,
  loadBacktestSessionFills,
  loadBacktestSessionsPage,
} from "../backtest/jobs/backtestSessionStore.js";

// Model backtesting (docs/backtesting/), local only: app.ts mounts this router only when BACKTEST_DATA_DIR is set.
// Shapes are backtestTypes.ts, which the app mirrors.

export const backtestRouter = Router();
backtestRouter.use(requireAuth);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An optional true/false body field: absent (or null) is false. */
function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new BacktestRequestError(`${field} must be true or false.`, 400);
  return value;
}

function requireUuidParameter(value: string | undefined, what: string): string {
  if (!value || !uuidPattern.test(value)) throw new BacktestRequestError(`No such ${what}.`, 404);
  return value;
}

backtestRouter.get("/overview", async (_request, response) => {
  // Reading the overview is one of the moments the queues move on (a stopped download or backtest no longer blocks them).
  await Promise.all([kickDownloadQueue(), kickBacktestQueue()]);
  const [files, jobs, suitabilityBySymbol] = await Promise.all([summarizeBacktestDataFiles(), listOverviewJobViews(), loadTickerSuitabilityBySymbol()]);
  const overview: BacktestOverview = { dataDirectory: requireBacktestDataDirectory(), files, suitabilityBySymbol, jobs, maxParallelSessions: readBacktestMaxParallelSessions() };
  response.json(overview);
});

// Body: { status: "suitable" | "unsuitable", note }. Admin only; the ticker must have a data file.
backtestRouter.put("/ticker-suitability/:symbol", requireAdmin, async (request: Request<{ symbol: string }>, response: Response) => {
  let symbol: string;
  try {
    symbol = normalizeBacktestSymbol(request.params.symbol ?? "");
  } catch (error) {
    throw new BacktestRequestError(error instanceof Error ? error.message : String(error), 400);
  }
  const body = (request.body ?? {}) as { status?: unknown; note?: unknown };
  const status = tickerSuitabilityMarks.find((candidate) => candidate === body.status);
  if (!status) throw new BacktestRequestError(`status must be one of ${tickerSuitabilityMarks.join(", ")}.`, 400);
  if (typeof body.note !== "string") throw new BacktestRequestError("note must be text.", 400);
  if (body.note.trim().length > tickerSuitabilityNoteMaxLength) throw new BacktestRequestError(`The note must be at most ${tickerSuitabilityNoteMaxLength} characters.`, 400);
  if (!listBacktestDataFileSymbols().includes(symbol)) throw new BacktestRequestError(`${symbol} has no data file.`, 404);
  response.json(await saveTickerSuitability({ symbol, status, note: body.note, userId: request.session.userId ?? null }));
});

backtestRouter.post("/downloads", async (request, response) => {
  const body = (request.body ?? {}) as { symbol?: unknown; startDate?: unknown; putFirst?: unknown; pauseRunning?: unknown };
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
  const putFirst = optionalBoolean(body.putFirst, "putFirst");
  const pauseRunning = optionalBoolean(body.pauseRunning, "pauseRunning");
  if (pauseRunning && !putFirst) throw new BacktestRequestError("pauseRunning goes with putFirst: only a download put first can pause the running one.", 400);
  response.status(201).json(await createDownloadJob({ symbol, startDate, endDate, putFirst, pauseRunning }));
});

backtestRouter.delete("/data-files/:symbol", async (request, response) => {
  let symbol: string;
  try {
    symbol = normalizeBacktestSymbol(request.params.symbol ?? "");
  } catch (error) {
    throw new BacktestRequestError(error instanceof Error ? error.message : String(error), 400);
  }
  await deleteBacktestDataFile(symbol);
  response.status(204).end();
});

backtestRouter.post("/jobs/:id/cancel", async (request, response) => {
  response.json(await cancelBacktestJob(requireUuidParameter(request.params.id, "job")));
});

backtestRouter.post("/jobs/:id/put-first", async (request, response) => {
  const body = (request.body ?? {}) as { pauseRunning?: unknown };
  response.json(await putDownloadFirst(requireUuidParameter(request.params.id, "job"), { pauseRunning: optionalBoolean(body.pauseRunning, "pauseRunning") }));
});

backtestRouter.post("/jobs/:id/resume", async (request, response) => {
  response.json(await resumeBacktestJob(requireUuidParameter(request.params.id, "job")));
});

function labSettingsView(lab: BacktestLabSettings): BacktestLabSettingsView {
  const template: BacktestSettingsTemplate = { settings: lab.settings, rows: buildBacktestSettingRows(lab.settings, { claudeCliAvailable: readBacktestClaudeCliPath() !== null }), notReplayed: [...backtestNotReplayed] };
  return { ...template, defaultPotDollars: lab.defaultPotDollars, updatedAt: lab.updatedAt };
}

/** Runs a lab store call, its validation errors answered as 400s. */
async function withLabValidation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BacktestLabSettingsValidationError) throw new BacktestRequestError(error.message, 400);
    throw error;
  }
}

// The New session table starts from the lab's global settings (Marcelo 2026-10-15: the lab is separate from Pluto's
// live settings and never syncs with them).
backtestRouter.get("/settings-template", async (_request, response) => {
  const template: BacktestSettingsTemplate = labSettingsView(await loadBacktestLabSettings());
  response.json({ settings: template.settings, rows: template.rows, notReplayed: template.notReplayed });
});

backtestRouter.get("/lab-settings", async (_request, response) => {
  response.json(labSettingsView(await loadBacktestLabSettings()));
});

// Body: { overrides?: <the New session's overrides shape>, defaultPotDollars?: number }. Answers the saved settings and
// the values that changed.
backtestRouter.put("/lab-settings", async (request, response) => {
  const body = (request.body ?? {}) as { overrides?: unknown; defaultPotDollars?: unknown };
  const { lab, changes, auditIds } = await withLabValidation(() => updateBacktestLabSettings(body, request.session.userId ?? null));
  // Saving the global lab values re-runs every stored analysis they reach: a ticker's own value for a field shields it.
  const changedFields = changes.map((change) => change.field);
  const overridesBySymbol = new Map((await loadBacktestLabTickerOverrides()).map((row) => [row.symbol, row]));
  const reached = changedFields.length === 0 ? [] : (await listAnalysedSymbols()).filter((symbol) => globalChangeReachesTicker(changedFields, overridesBySymbol.get(symbol) ?? null));
  const analyses = await rerunAnalysesAfterSave(reached, "global_settings");
  await noteLabAuditAnalysesRerun(auditIds, analyses.started.length);
  response.json({ settings: labSettingsView(lab), changes, analyses });
});

// The save's confirmation: the same body as PUT, nothing written. Each change with the analysed tickers it re-runs and
// the tickers whose own value keeps it from reaching them; `reruns` is every ticker the save re-runs.
backtestRouter.post("/lab-settings/preview", async (request, response) => {
  const body = (request.body ?? {}) as { overrides?: unknown; defaultPotDollars?: unknown };
  const { changes } = await withLabValidation(() => updateBacktestLabSettings(body, request.session.userId ?? null, undefined, { dryRun: true }));
  const overrides = await loadBacktestLabTickerOverrides();
  const overridesBySymbol = new Map(overrides.map((row) => [row.symbol, row]));
  const analysed = await listAnalysedSymbols();
  response.json({
    changes: changes.map((change) => ({
      ...change,
      reruns: analysisReadsLabPath(change.field) ? analysed.filter((symbol) => !tickerOverridesGlobalPath(change.field, overridesBySymbol.get(symbol) ?? null)) : [],
      keptOverrides: overrides.filter((row) => tickerOverridesGlobalPath(change.field, row)).map((row) => row.symbol),
    })),
    reruns: changes.length === 0 ? [] : analysed.filter((symbol) => globalChangeReachesTicker(changes.map((change) => change.field), overridesBySymbol.get(symbol) ?? null)),
  });
});

// ?symbol=XYZ: one ticker's own values; ?symbol= (empty): the global values only; absent: everything.
backtestRouter.get("/lab-settings/audit", async (request, response) => {
  const raw = request.query.symbol;
  const symbol = raw === undefined ? undefined : typeof raw === "string" && raw.trim() !== "" ? normalizeBacktestSymbol(raw) : null;
  response.json(await loadBacktestLabAudit({ symbol }));
});

backtestRouter.get("/lab-ticker-overrides", async (_request, response) => {
  response.json(await loadBacktestLabTickerOverrides());
});

backtestRouter.get("/lab-ticker-overrides/:symbol", async (request, response) => {
  const symbol = await withLabValidation(async () => normalizeBacktestSymbol(request.params.symbol ?? ""));
  const overrides = (await loadBacktestLabTickerOverrides()).find((row) => row.symbol === symbol) ?? null;
  response.json({ symbol, overrides });
});

// Body: any of potDollars, ladderSharesPct, ladderRungs, ladderShockPct, minAbsDelta, maxAbsDelta: a number, or null for
// the global value again.
backtestRouter.put("/lab-ticker-overrides/:symbol", async (request, response) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const { overrides, changes } = await withLabValidation(() => saveBacktestLabTickerOverrides(request.params.symbol ?? "", body, request.session.userId ?? null));
  // Save for the ticker updates its analysis at once, so the stored analysis always matches its saved values.
  const symbol = normalizeBacktestSymbol(request.params.symbol ?? "");
  response.json({ overrides, changes, analyses: changes.length === 0 ? { started: [], skipped: [] } : await rerunAnalysesAfterSave([symbol], "ticker_settings") });
});

backtestRouter.post("/sessions", async (request, response) => {
  const { snapshot, value, warnings, llmEstimate } = await validateSessionRequestAgainstLab(request.body);
  response.status(201).json({ ...(await createBacktestSession(value, snapshot)), warnings, llmEstimate, resolvedBySymbol: value.symbolSettings });
});

// The New session form starts a batch: 1 to 9 runs on one period and the same settings (CreateBacktestBatchRequest).
backtestRouter.post("/batches", async (request, response) => {
  const { name, runs, warnings, llmEstimate } = await validateBatchRequestAgainstLab(request.body);
  const created = await createBacktestBatch(name, runs);
  const answer: CreateBacktestBatchResponse = { ...created, warnings, llmEstimate };
  response.status(201).json(answer);
});

backtestRouter.get("/batches/:id", async (request, response) => {
  // The batch page polls while its runs are queued or running: one of the moments the queue moves on.
  await kickBacktestQueue();
  response.json(await loadBacktestBatchDetail(requireUuidParameter(request.params.id, "batch")));
});

// ?runs=1,3: two or more finished runs of the batch, added up as one portfolio (formula F1).
backtestRouter.get("/batches/:id/combined", async (request, response) => {
  const batchId = requireUuidParameter(request.params.id, "batch");
  const given = String(request.query.runs ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const runNumbers = [...new Set(given.map(Number))];
  if (runNumbers.some((runNumber) => !Number.isInteger(runNumber) || runNumber < 1)) throw new BacktestRequestError("runs must be run numbers: ?runs=1,3", 400);
  if (runNumbers.length < 2) throw new BacktestRequestError("Combine two or more runs: ?runs=1,3", 400);
  response.json(await loadBacktestBatchCombined(batchId, runNumbers.sort((a, b) => a - b)));
});

backtestRouter.delete("/batches/:id", async (request, response) => {
  await deleteBacktestBatch(requireUuidParameter(request.params.id, "batch"));
  response.status(204).end();
});

// The New session screen's estimate before anything starts: the same request body, checked the same way (a name is not
// needed yet), nothing created.
backtestRouter.post("/sessions/estimate", async (request, response) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const checked = await checkSessionRequestAgainstLab({ ...body, name: typeof body.name === "string" && body.name.trim() !== "" ? body.name : "estimate" });
  // Tickers whose values cannot run still answer, each with its problems, so the screen shows them all at once.
  const estimate: BacktestSessionEstimateResponse =
    checked.kind === "ticker_problems"
      ? { warnings: checked.warnings, llmEstimate: null, capital: checked.tickerProblems.capital, bookMode: "pots", resolvedBySymbol: checked.tickerProblems.bySymbol }
      : { warnings: checked.warnings, llmEstimate: checked.llmEstimate, capital: checked.value.startingValue, bookMode: checked.value.bookMode, resolvedBySymbol: checked.value.symbolResolution };
  response.json(estimate);
});

// ?symbol=XYZ narrows the option sales, positions, cycles and statistics to one symbol of the session's book.
// The sessions grow with every run, so they are listed page by page, newest first, filtered by name, symbol and status
// (BacktestSessionsPageQuery); each carries its latest job's run, since the overview lists only the latest jobs.
backtestRouter.get("/sessions", async (request, response) => {
  const validation = validateBacktestSessionsPageQuery(request.query as Record<string, unknown>);
  if (!validation.ok) throw new BacktestRequestError(validation.error, 400);
  response.json(await loadBacktestSessionsPage(validation.filters));
});

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

registerTickerAnalysisRoutes(backtestRouter);

// A request the job or session state does not allow is answered with its own status and message; anything else goes on
// to the app's error handler.
backtestRouter.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
  if (error instanceof BacktestRequestError) {
    response.status(error.httpStatus).json({ error: error.message });
    return;
  }
  next(error);
});
