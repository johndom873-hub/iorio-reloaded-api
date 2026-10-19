import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { normalizeBacktestSymbol } from "../backtestDataDirectory.js";
import { readBacktestDataFileContents } from "../dataFileSummary.js";
import { loadBacktestLabSettings, loadBacktestLabTickerOverrides, tickerOverridesToValues } from "../labSettingsStore.js";
import { defaultBacktestBaselineSettings, type BacktestBaselineSettings, type BacktestLabTickerOverrides, type BacktestSettings, type BacktestTickerProfile, type BacktestTickerSuitability } from "../backtestTypes.js";
import { loadTickerProfile } from "../tickerProfileStore.js";
import { loadTickerSuitability } from "../tickerSuitabilityStore.js";
import { validateBaselineSettings } from "../jobs/backtestSessionRequest.js";
import { deriveJobDisplayStatus } from "../jobs/backtestJobRules.js";
import { BacktestRequestError, cancelBacktestJob, findUnfinishedDownloadJob, insertClaimedAnalysisJob, startClaimedBacktestJob } from "../jobs/backtestJobStore.js";
import { analysisFormulasVersion, type AnalysisFigureValues, type AnalysisStep } from "./analysisFigures.js";

// The stored analyses (backtest_ticker_analyses): the values each was computed with, starting one as an "analysis" job,
// and what the Analyse window and the Data files table read.

/** "manual": Update Analysis; "ticker_settings" / "global_settings": a save of the lab values re-ran it; "trial": Run with these values (never the stored analysis). */
export type AnalysisReason = "manual" | "ticker_settings" | "global_settings" | "trial";

/** Run with these values: the settings panel's values, over the ticker's lab values; nothing is saved. */
export interface AnalysisTrialValues {
  potDollars?: number;
  ladderSharesPct?: number;
  ladderRungs?: number;
  /** A fixed shock; null: the lab's shock rule. */
  ladderShockPct?: number | null;
  minAbsDelta?: number;
  maxAbsDelta?: number;
  minDte?: number;
  maxDte?: number;
  maxSpreadPctOfMid?: number;
}

const trialNumberFields = ["potDollars", "ladderSharesPct", "ladderRungs", "ladderShockPct", "minAbsDelta", "maxAbsDelta", "minDte", "maxDte", "maxSpreadPctOfMid"] as const;

/** What a stored analysis was computed with. */
export interface AnalysisLabValues {
  settings: BacktestSettings;
  defaultPotDollars: number;
  tickerOverrides: Omit<BacktestLabTickerOverrides, "updatedAt"> | null;
  trial: AnalysisTrialValues | null;
  /** The values the figures read, resolved from the above. */
  effective: AnalysisFigureValues;
}

export function validateAnalysisTrialValues(raw: unknown): AnalysisTrialValues {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BacktestRequestError("values must be an object.", 400);
  const unknown = Object.keys(raw).find((key) => !(trialNumberFields as readonly string[]).includes(key));
  if (unknown) throw new BacktestRequestError(`values.${unknown} is not a value the analysis can try.`, 400);
  const values: AnalysisTrialValues = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null && key === "ladderShockPct") values.ladderShockPct = null;
    else if (typeof value !== "number" || !Number.isFinite(value)) throw new BacktestRequestError(`values.${key} must be a number.`, 400);
    else values[key as Exclude<(typeof trialNumberFields)[number], "ladderShockPct">] = value;
  }
  if (values.potDollars !== undefined && !(values.potDollars > 0)) throw new BacktestRequestError("The pot must be above $0.", 400);
  return values;
}

/** Sorted keys at every level, so equal values hash alike whatever order Postgres stored them in. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** The lab values an analysis reads (analysisReadsLabPath): a change to Pluto's own rows leaves the hash as it was. Stored runs
 *  may hold partial settings (written by tests or older code), hence the optional reads. */
function analysisReadValues({ settings, defaultPotDollars, tickerOverrides, trial }: Omit<AnalysisLabValues, "effective">) {
  return { defaultPotDollars, tickerOverrides, trial, settings: { baseline: settings?.baseline, model: settings?.model, trading: { spreadCostChargedPct: settings?.trading?.spreadCostChargedPct }, pluto: { windowStartEt: settings?.pluto?.windowStartEt, windowEndEt: settings?.pluto?.windowEndEt } } };
}

export const hashAnalysisLabValues = (values: Omit<AnalysisLabValues, "effective">) => createHash("sha256").update(stableJson(analysisReadValues(values))).digest("hex").slice(0, 32);

/** The ticker's lab values now (the lab's global values, its overrides on top), and a trial's on top of those. */
export async function resolveAnalysisLabValues(symbol: string, trial: AnalysisTrialValues | null, connection: Knex = db): Promise<AnalysisLabValues & { hash: string }> {
  const [lab, overrides] = await Promise.all([loadBacktestLabSettings(connection), loadBacktestLabTickerOverrides(connection)]);
  const override = overrides.find((row) => row.symbol === symbol) ?? null;
  const tickerValues = override ? tickerOverridesToValues(override) : null;
  // The window's |delta| range is the Calls' (Marcelo 2026-10-16): every Call on minAbsDelta–maxAbsDelta, whatever the lab's callDeltaRange.
  const baseline: BacktestBaselineSettings = { ...defaultBacktestBaselineSettings, ...lab.settings.baseline, ...(tickerValues?.baseline ?? {}), callDeltaRange: "entry_range" };
  let potDollars = tickerValues?.potDollars ?? lab.defaultPotDollars;
  if (trial) {
    const { potDollars: trialPot, ladderShockPct, ...rest } = trial;
    Object.assign(baseline, rest);
    if (ladderShockPct !== undefined) Object.assign(baseline, ladderShockPct === null ? { ladderShock: lab.settings.baseline?.ladderShock ?? defaultBacktestBaselineSettings.ladderShock, ladderShockPct: lab.settings.baseline?.ladderShockPct ?? defaultBacktestBaselineSettings.ladderShockPct } : { ladderShock: "fixed", ladderShockPct });
    if (trialPot !== undefined) potDollars = trialPot;
    const problem = validateBaselineSettings(baseline as unknown as Record<string, unknown>);
    if (problem) throw new BacktestRequestError(problem, 400);
  }
  const tickerOverrides = override ? (({ updatedAt: _updatedAt, ...fields }) => fields)(override) : null;
  const stored = { settings: lab.settings, defaultPotDollars: lab.defaultPotDollars, tickerOverrides, trial };
  return { ...stored, effective: { potDollars, baseline, spreadShareCharged: lab.settings.trading.spreadCostChargedPct / 100 }, hash: hashAnalysisLabValues(stored) };
}

/** The unfinished analyses of a symbol (queued or running, not stopped), trial or saved. */
async function findActiveAnalyses(symbol: string, connection: Knex): Promise<{ id: string; job_id: string | null; reason: AnalysisReason }[]> {
  const rows: { id: string; job_id: string | null; reason: AnalysisReason; job_status: string | null; heartbeat_at: Date | null }[] = await connection("backtest_ticker_analyses as a")
    .leftJoin("backtest_jobs as j", "j.id", "a.job_id")
    .where("a.symbol", symbol)
    .whereIn("a.status", ["queued", "running"])
    .select("a.id", "a.job_id", "a.reason", "j.status as job_status", "j.heartbeat_at");
  const now = new Date();
  return rows.filter((row) => row.job_status !== null && ["queued", "running"].includes(deriveJobDisplayStatus(row.job_status as never, row.heartbeat_at ? new Date(row.heartbeat_at) : null, now)));
}

/**
 * Starts an analysis as a job. A trial runs beside a saved one; a save of the lab values replaces the saved analysis
 * running (its job is cancelled, its backtest session with it); Update Analysis is refused while one runs, and while the
 * ticker's download runs (the file is being written).
 */
export async function startTickerAnalysis(input: { symbol: string; reason: AnalysisReason; trial?: AnalysisTrialValues | null }, connection: Knex = db): Promise<{ analysisId: string; jobId: string }> {
  let symbol: string;
  try {
    symbol = normalizeBacktestSymbol(input.symbol);
  } catch (error) {
    throw new BacktestRequestError(error instanceof Error ? error.message : String(error), 400);
  }
  const contents = readBacktestDataFileContents(symbol);
  if (!contents) throw new BacktestRequestError(`There is no data file for ${symbol}: download it first.`, 404);
  if (!contents.firstDate) throw new BacktestRequestError(`The ${symbol} data file has no complete days yet.`, 409);
  if (await findUnfinishedDownloadJob(symbol)) throw new BacktestRequestError(`${symbol}'s download is running: analyse it once the download finishes.`, 409);
  const trial = input.reason === "trial" ? (input.trial ?? {}) : null;
  const values = await resolveAnalysisLabValues(symbol, trial, connection);
  const active = (await findActiveAnalyses(symbol, connection)).filter((row) => (row.reason === "trial") === (trial !== null));
  if (active.length > 0) {
    if (input.reason === "manual" || input.reason === "trial") throw new BacktestRequestError(`An analysis of ${symbol} is already running.`, 409);
    for (const row of active) if (row.job_id) await cancelBacktestJob(row.job_id).catch(() => undefined);
  }
  const { hash, ...labValues } = values;
  const ids = await connection.transaction(async (transaction) => {
    const jobId = await insertClaimedAnalysisJob(symbol, transaction);
    const [row] = await transaction("backtest_ticker_analyses")
      .insert({ symbol, job_id: jobId, status: "queued", formulas_version: analysisFormulasVersion, lab_values: JSON.stringify(labValues), lab_values_hash: hash, reason: input.reason, summary_status: "pending" })
      .returning("id");
    return { analysisId: row.id as string, jobId };
  });
  await startClaimedBacktestJob(ids.jobId);
  return ids;
}

/** Re-runs the stored analyses a save of lab values reaches: one ticker's, or every analysed ticker's that the change reaches. */
export async function rerunAnalysesAfterSave(symbols: readonly string[], reason: "ticker_settings" | "global_settings"): Promise<{ started: string[]; skipped: { symbol: string; reason: string }[] }> {
  const started: string[] = [];
  const skipped: { symbol: string; reason: string }[] = [];
  for (const symbol of symbols) {
    try {
      await startTickerAnalysis({ symbol, reason });
      started.push(symbol);
    } catch (error) {
      skipped.push({ symbol, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { started, skipped };
}

/** Symbols with at least one saved analysis (not a trial), for a global save's re-run. */
export async function listAnalysedSymbols(connection: Knex = db): Promise<string[]> {
  const rows: { symbol: string }[] = await connection("backtest_ticker_analyses").whereNot({ reason: "trial" }).distinct("symbol").orderBy("symbol");
  return rows.map((row) => row.symbol);
}

export interface AnalysisRunView {
  id: string;
  symbol: string;
  reason: AnalysisReason;
  /** The job's state when the analysis has not finished ("stopped": its process stopped reporting). */
  status: "queued" | "running" | "stopped" | "succeeded" | "failed" | "cancelled";
  step: AnalysisStep | null;
  progressDone: number;
  progressTotal: number;
  jobId: string | null;
  sessionId: string | null;
  formulasVersion: number;
  labValues: AnalysisLabValues;
  labValuesHash: string;
  optionLastDate: string | null;
  barsLastDate: string | null;
  figuresSeconds: number | null;
  summaryStatus: string;
  summaryError: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface AnalysisRow {
  id: string;
  symbol: string;
  job_id: string | null;
  status: AnalysisRunView["status"];
  formulas_version: number;
  lab_values: AnalysisLabValues;
  lab_values_hash: string;
  option_last_date: string | null;
  bars_last_date: string | null;
  session_id: string | null;
  figures?: unknown;
  figures_seconds: string | null;
  summary_status: string;
  summary?: unknown;
  summary_error: string | null;
  error: string | null;
  reason: AnalysisReason;
  created_at: Date;
  finished_at: Date | null;
  job_status: string | null;
  job_heartbeat_at: Date | null;
  job_progress_done: number | null;
  job_progress_total: number | null;
  job_progress_label: string | null;
}

const analysisColumns = (connection: Knex) => [
  "a.id",
  "a.symbol",
  "a.job_id",
  "a.status",
  "a.formulas_version",
  "a.lab_values",
  "a.lab_values_hash",
  connection.raw("a.option_last_date::text as option_last_date"),
  connection.raw("a.bars_last_date::text as bars_last_date"),
  "a.session_id",
  "a.figures_seconds",
  "a.summary_status",
  "a.summary_error",
  "a.error",
  "a.reason",
  "a.created_at",
  "a.finished_at",
  "j.status as job_status",
  "j.heartbeat_at as job_heartbeat_at",
  "j.progress_done as job_progress_done",
  "j.progress_total as job_progress_total",
  "j.progress_label as job_progress_label",
];

function toRunView(row: AnalysisRow, now = new Date()): AnalysisRunView {
  const unfinished = row.status === "queued" || row.status === "running";
  const jobStatus = row.job_status === null ? null : deriveJobDisplayStatus(row.job_status as never, row.job_heartbeat_at ? new Date(row.job_heartbeat_at) : null, now);
  // A job that ended without its process writing the analysis (cancelled while stopped, deleted) ends the analysis too.
  const status: AnalysisRunView["status"] = !unfinished ? row.status : jobStatus === null ? "cancelled" : jobStatus === "succeeded" ? "failed" : (jobStatus as AnalysisRunView["status"]);
  return {
    id: row.id,
    symbol: row.symbol,
    reason: row.reason,
    status,
    step: unfinished ? ((row.job_progress_label as AnalysisStep | null) ?? null) : null,
    progressDone: Number(row.job_progress_done ?? 0),
    progressTotal: Number(row.job_progress_total ?? 0),
    jobId: row.job_id,
    sessionId: row.session_id,
    formulasVersion: row.formulas_version,
    labValues: row.lab_values,
    // From the stored values, so a run saved before the hash covered only what an analysis reads compares alike.
    labValuesHash: row.lab_values ? hashAnalysisLabValues(row.lab_values) : row.lab_values_hash,
    optionLastDate: row.option_last_date,
    barsLastDate: row.bars_last_date,
    figuresSeconds: row.figures_seconds === null ? null : Number(row.figures_seconds),
    summaryStatus: row.summary_status,
    summaryError: row.summary_error,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

const selectAnalyses = (connection: Knex) => connection("backtest_ticker_analyses as a").leftJoin("backtest_jobs as j", "j.id", "a.job_id");

export interface TickerAnalysisView {
  symbol: string;
  /** The latest succeeded saved analysis, with its figures and summary. */
  stored: (AnalysisRunView & { figures: unknown; summary: unknown }) | null;
  /** The latest trial that succeeded after the stored one, with its figures and summary. */
  trial: (AnalysisRunView & { figures: unknown; summary: unknown }) | null;
  /** Analyses not finished yet (a saved one and a trial at most), and the latest that failed or stopped since the stored one. */
  active: AnalysisRunView[];
  latestProblem: AnalysisRunView | null;
  /** The ticker's lab values now, and their hash: a stored analysis with another hash was computed with other values. */
  currentHash: string;
  /** The file now runs past the stored analysis's last day. */
  fileLastDate: string | null;
  currentFormulasVersion: number;
  /** The header's name and classification; null when nothing is stored for the ticker. */
  profile: BacktestTickerProfile | null;
  /** As on the Data files table; null: Pending. */
  suitability: BacktestTickerSuitability | null;
}

export async function loadTickerAnalysisView(givenSymbol: string, connection: Knex = db): Promise<TickerAnalysisView> {
  const symbol = normalizeBacktestSymbol(givenSymbol);
  const now = new Date();
  const recent: AnalysisRow[] = await selectAnalyses(connection).where("a.symbol", symbol).orderBy("a.created_at", "desc").limit(20).select(analysisColumns(connection));
  const views = recent.map((row) => toRunView(row, now));
  const storedView = views.find((view) => view.reason !== "trial" && view.status === "succeeded") ?? null;
  const trialView = views.find((view) => view.reason === "trial" && view.status === "succeeded" && (!storedView || view.createdAt > storedView.createdAt)) ?? null;
  const withBody = async (view: AnalysisRunView | null) => {
    if (!view) return null;
    const body = await connection("backtest_ticker_analyses").where({ id: view.id }).first("figures", "summary");
    return { ...view, figures: body?.figures ?? null, summary: body?.summary ?? null };
  };
  const current = await resolveAnalysisLabValues(symbol, null, connection);
  return {
    symbol,
    stored: await withBody(storedView),
    trial: await withBody(trialView),
    active: views.filter((view) => view.status === "queued" || view.status === "running"),
    latestProblem: views.find((view) => ["failed", "stopped"].includes(view.status) && view.reason !== "trial" && (!storedView || view.createdAt > storedView.createdAt)) ?? null,
    currentHash: current.hash,
    fileLastDate: readBacktestDataFileContents(symbol)?.lastDate ?? null,
    currentFormulasVersion: analysisFormulasVersion,
    profile: await loadTickerProfile(symbol, connection),
    suitability: await loadTickerSuitability(symbol, connection),
  };
}

export async function loadTickerAnalysisRun(analysisId: string, connection: Knex = db): Promise<AnalysisRunView> {
  const row: AnalysisRow | undefined = await selectAnalyses(connection).where("a.id", analysisId).first(analysisColumns(connection));
  if (!row) throw new BacktestRequestError("No such analysis.", 404);
  return toRunView(row);
}

/** The analyses of a symbol, latest first, without their figures. */
export async function listTickerAnalysisRuns(givenSymbol: string, limit = 50, connection: Knex = db): Promise<AnalysisRunView[]> {
  const symbol = normalizeBacktestSymbol(givenSymbol);
  const rows: AnalysisRow[] = await selectAnalyses(connection).where("a.symbol", symbol).orderBy("a.created_at", "desc").limit(limit).select(analysisColumns(connection));
  const now = new Date();
  return rows.map((row) => toRunView(row, now));
}

export async function cancelTickerAnalysis(analysisId: string, connection: Knex = db): Promise<AnalysisRunView> {
  const run = await loadTickerAnalysisRun(analysisId, connection);
  if (!run.jobId || !["queued", "running", "stopped"].includes(run.status)) throw new BacktestRequestError("This analysis has already finished.", 409);
  await cancelBacktestJob(run.jobId);
  if (run.status === "stopped") await connection("backtest_ticker_analyses").where({ id: analysisId }).whereIn("status", ["queued", "running"]).update({ status: "cancelled", finished_at: connection.fn.now() });
  return loadTickerAnalysisRun(analysisId, connection);
}

/** For the Data files table: each symbol's latest saved analysis state. */
export async function loadAnalysisStatusBySymbol(connection: Knex = db): Promise<Map<string, { status: AnalysisRunView["status"]; finishedAt: string | null; optionLastDate: string | null; labValuesHash: string }>> {
  const rows: AnalysisRow[] = await selectAnalyses(connection)
    .distinctOn("a.symbol")
    .whereNot("a.reason", "trial")
    .orderBy([{ column: "a.symbol" }, { column: "a.created_at", order: "desc" }])
    .select(analysisColumns(connection));
  const now = new Date();
  return new Map(rows.map((row) => {
    const view = toRunView(row, now);
    return [view.symbol, { status: view.status, finishedAt: view.finishedAt, optionLastDate: view.optionLastDate, labValuesHash: view.labValuesHash }];
  }));
}
