import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { normalizeBacktestSymbol, readBacktestDataDirectory } from "../backtestDataDirectory.js";
import { cachedSplitsBetween } from "../engine/splitFactors.js";
import { readBacktestDataFileContents } from "../dataFileSummary.js";
import { loadBacktestLabSettings, withCodeKeys } from "../labSettingsStore.js";
import { defaultBacktestVolFarmerV4Settings, type BacktestDetectedSplit, type BacktestSettings, type BacktestTickerProfile, type BacktestTickerSuitability } from "../backtestTypes.js";
import { loadTickerProfile } from "../tickerProfileStore.js";
import { loadTickerSuitability } from "../tickerSuitabilityStore.js";
import { BacktestLabSettingsValidationError } from "../labSettingsStore.js";
import { loadAllTickerOwnValues, loadTickerOwnValues, mergedVolFarmerV4Problem, tickerFieldValuesOf, validateTickerOwnValuesInput, withTickerOwnValues, type StoredTickerOwnValues, type TickerFieldValues, type TickerOwnValues } from "../labTickerValuesStore.js";
import { deriveJobDisplayStatus } from "../jobs/backtestJobRules.js";
import { BacktestRequestError, cancelBacktestJob, findUnfinishedDownloadJob, insertQueuedAnalysisJob, kickAnalysisQueue } from "../jobs/backtestJobStore.js";
import { analysisFormulasVersion, computeAnalysisFileFigures, type AnalysisFigures, type AnalysisFigureValues, type AnalysisFileFigures, type AnalysisStep } from "./analysisFigures.js";
import type { AnalysisBacktestFigures } from "./analysisBacktest.js";
import { barIndicatorsOf } from "./analysisPriceFigures.js";
import { oneTickerPotShareOfAccount } from "./analysisPotSizing.js";
import type { SuitabilityCheck } from "./analysisSuitabilityRule.js";

// The stored analyses (backtest_ticker_analyses): the values each was computed with, starting one as an "analysis" job,
// and what the Analyse window and the Data files table read. Since Vol Farmer v4 (Marcelo 2026-11-01) an analysis reads the
// lab's v4 values, with the ticker's own values on top (labTickerValuesStore.ts), and the lab's default account; a save of
// the lab marks the analyses it reaches out of date, and "Re-run out of date" runs them again (no automatic re-runs).

/** "manual": Re-run analysis; "global_settings": Re-run out of date (and, before v4, a save of the lab); "ticker_settings": Save and Analyse (the ticker's own values saved); "trial": Run a trial or Analyse Only (never the stored analysis). */
export type AnalysisReason = "manual" | "ticker_settings" | "global_settings" | "trial";

/** A trial: the analysis at another starting account, or with other values for the ticker's five (Analyse Only); nothing is saved as the ticker's analysis. */
export interface AnalysisTrialValues {
  accountDollars: number;
  /** Values for the ticker's five on top of its own and the lab's; absent: those. */
  volFarmerV4?: Partial<TickerFieldValues>;
}

/** What a stored analysis was computed with. */
export interface AnalysisLabValues {
  settings: BacktestSettings;
  defaultPotDollars: number;
  /** The ticker's own values it read (null: the lab's); null when it had none, and in analyses stored before them. */
  tickerValues: TickerOwnValues | null;
  trial: AnalysisTrialValues | null;
  /** The values the figures read, resolved from the above. */
  effective: AnalysisFigureValues;
}

/** What the hash reads: an analysis stored before the ticker's own values has no tickerValues. */
type AnalysisHashedValues = Omit<AnalysisLabValues, "effective" | "tickerValues"> & { tickerValues?: TickerOwnValues | null };

/** The figures the Data files table shows for an analysis (table_figures). */
export interface AnalysisTableFigures {
  verdict: "suits" | "doesnt_suit";
  failedChecks: SuitabilityCheck[];
  uncoveredWindows: number[];
  /** S1 over the last 12 months, a yearly fraction. */
  optionsIncomeTwelveMonths: number | null;
  v4Cagr: number | null;
  holdCagr: number | null;
  v4ExcessCalmar: number | null;
  holdExcessCalmar: number | null;
  smallestPotDollars: number | null;
}

export function validateAnalysisTrialValues(raw: unknown): AnalysisTrialValues {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BacktestRequestError("values must be an object.", 400);
  const unknown = Object.keys(raw).find((key) => key !== "accountDollars" && key !== "volFarmerV4");
  if (unknown) throw new BacktestRequestError(`values.${unknown} is not a value the analysis can try: only accountDollars, the starting account, and volFarmerV4, the ticker's values.`, 400);
  const { accountDollars, volFarmerV4 } = raw as { accountDollars?: unknown; volFarmerV4?: unknown };
  if (typeof accountDollars !== "number" || !Number.isFinite(accountDollars) || !(accountDollars > 0)) throw new BacktestRequestError("values.accountDollars must be a number above $0.", 400);
  if (volFarmerV4 === undefined) return { accountDollars };
  try {
    return { accountDollars, volFarmerV4: validateTickerOwnValuesInput(volFarmerV4, { allowNull: false, what: "values.volFarmerV4" }) as Partial<TickerFieldValues> };
  } catch (error) {
    if (error instanceof BacktestLabSettingsValidationError) throw new BacktestRequestError(error.message, 400);
    throw error;
  }
}

/** Sorted keys at every level, so equal values hash alike whatever order Postgres stored them in. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** The v4 section an analysis runs: the lab's (in the code's shape), the ticker's own values on top, then a trial's. */
export function analysisVolFarmerV4Of({ settings, tickerValues, trial }: Pick<AnalysisHashedValues, "settings" | "tickerValues" | "trial">) {
  return withTickerOwnValues(withTickerOwnValues(withCodeKeys(defaultBacktestVolFarmerV4Settings, settings?.volFarmerV4), tickerValues), trial?.volFarmerV4);
}

/**
 * The lab values an analysis reads: v4's section as it runs it (analysisVolFarmerV4Of: in the code's shape, withCodeKeys,
 * so a setting added at its default or one removed leaves runs current; with the ticker's own values on top, so a lab
 * change to a value the ticker holds leaves its analysis current), Pluto's window the looks keep to, and the default
 * account. A change to anything else leaves the hash as it was; the Spread cost share is not read since v4's Calls, Puts
 * and buybacks fill one cent past the mid (2026-11-07).
 */
function analysisReadValues(values: AnalysisHashedValues) {
  const { settings, defaultPotDollars, trial } = values;
  return { defaultPotDollars, trial, settings: { volFarmerV4: analysisVolFarmerV4Of(values), pluto: { windowStartEt: settings?.pluto?.windowStartEt, windowEndEt: settings?.pluto?.windowEndEt } } };
}

export const hashAnalysisLabValues = (values: AnalysisHashedValues) => createHash("sha256").update(stableJson(analysisReadValues(values))).digest("hex").slice(0, 32);

/** A lab path's value among the values an analysis reads ("lab.defaultPotDollars", "volFarmerV4.callMaxAbsDelta", …). */
function readValueAt(values: ReturnType<typeof analysisReadValues>, path: string): unknown {
  if (path === "lab.defaultPotDollars") return values.defaultPotDollars;
  return path.split(".").reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), values.settings);
}

/**
 * The stored analyses a lab save leaves out of date (its confirmation and its answer): the analysed tickers whose latest
 * succeeded analysis ran with other values than the save leaves, and, for each changed value, those that ran with another.
 * A save that puts a value back to what an analysis ran with brings that analysis back up to date.
 */
export async function analysesOutOfDateAfter(lab: { settings: AnalysisLabValues["settings"]; defaultPotDollars: number }, changedPaths: readonly string[], connection: Knex = db): Promise<{ outOfDate: string[]; byPath: Record<string, string[]> }> {
  const rows: { symbol: string; lab_values: AnalysisHashedValues | null }[] = await connection("backtest_ticker_analyses")
    .distinctOn("symbol")
    .whereNot({ reason: "trial" })
    .where({ status: "succeeded" })
    .orderBy([{ column: "symbol" }, { column: "created_at", order: "desc" }])
    .select("symbol", "lab_values");
  const ownValuesBySymbol = await loadAllTickerOwnValues(connection);
  const byPath: Record<string, string[]> = Object.fromEntries(changedPaths.map((path) => [path, []]));
  const outOfDate: string[] = [];
  for (const row of rows) {
    if (!row.lab_values) continue;
    // Each ticker against the save with its own values on top.
    const after = { settings: lab.settings, defaultPotDollars: lab.defaultPotDollars, tickerValues: ownValuesBySymbol[row.symbol]?.values ?? null, trial: null };
    const ranWith = { ...row.lab_values, trial: null };
    if (hashAnalysisLabValues(ranWith) !== hashAnalysisLabValues(after)) outOfDate.push(row.symbol);
    const [ranWithValues, afterValues] = [analysisReadValues(ranWith), analysisReadValues(after)];
    for (const path of changedPaths) if (stableJson(readValueAt(ranWithValues, path)) !== stableJson(readValueAt(afterValues, path))) byPath[path]!.push(row.symbol);
  }
  return { outOfDate, byPath };
}

/** An analysis's values from the lab's, the ticker's own values and a trial's, and their hash. */
export function analysisLabValuesOf(lab: { settings: BacktestSettings; defaultPotDollars: number }, tickerValues: TickerOwnValues | null, trial: AnalysisTrialValues | null): AnalysisLabValues & { hash: string } {
  const stored = { settings: lab.settings, defaultPotDollars: lab.defaultPotDollars, tickerValues, trial };
  const v4 = analysisVolFarmerV4Of(stored);
  const accountDollars = trial?.accountDollars ?? lab.defaultPotDollars;
  const potShareOfAccount = oneTickerPotShareOfAccount(v4);
  return {
    ...stored,
    effective: { accountDollars, potDollars: accountDollars * potShareOfAccount, potShareOfAccount, firstPositionShare: v4.firstPositionPct / 100, v4 },
    hash: hashAnalysisLabValues(stored),
  };
}

/** The lab's values now, the symbol's own values on top, and a trial's. */
export async function resolveAnalysisLabValues(symbol: string, trial: AnalysisTrialValues | null, connection: Knex = db): Promise<AnalysisLabValues & { hash: string }> {
  const [lab, own] = await Promise.all([loadBacktestLabSettings(connection), loadTickerOwnValues(symbol, connection)]);
  return analysisLabValuesOf(lab, own?.values ?? null, trial);
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

function normalizedAnalysisSymbol(givenSymbol: string): string {
  try {
    return normalizeBacktestSymbol(givenSymbol);
  } catch (error) {
    throw new BacktestRequestError(error instanceof Error ? error.message : String(error), 400);
  }
}

/**
 * Why the ticker cannot be analysed now (BacktestRequestError): no data file, none of its days complete, its download
 * running (the file is being written), or an analysis of the same kind (a trial, or a saved one) already running.
 * Answers the symbol, normalized.
 */
export async function assertTickerCanBeAnalysed(givenSymbol: string, kind: "saved" | "trial", connection: Knex = db): Promise<string> {
  const symbol = normalizedAnalysisSymbol(givenSymbol);
  const contents = readBacktestDataFileContents(symbol);
  if (!contents) throw new BacktestRequestError(`There is no data file for ${symbol}: download it first.`, 404);
  if (!contents.firstDate) throw new BacktestRequestError(`The ${symbol} data file has no complete days yet.`, 409);
  if (await findUnfinishedDownloadJob(symbol)) throw new BacktestRequestError(`${symbol}'s download is running: analyse it once the download finishes.`, 409);
  const active = (await findActiveAnalyses(symbol, connection)).filter((row) => (row.reason === "trial") === (kind === "trial"));
  if (active.length > 0) throw new BacktestRequestError(`An analysis of ${symbol} is already running.`, 409);
  return symbol;
}

/**
 * Starts an analysis as a job in the analyses' queue (at once while fewer than BACKTEST_MAX_PARALLEL_ANALYSES run). A trial
 * runs beside a saved one; a saved one is refused while another saved one is queued or runs, and while the ticker's download
 * runs (the file is being written). A trial's values must leave a v4 section the lab could run.
 */
export async function startTickerAnalysis(input: { symbol: string; reason: AnalysisReason; trial?: AnalysisTrialValues | null }, connection: Knex = db): Promise<{ analysisId: string; jobId: string }> {
  const trial = input.reason === "trial" ? (input.trial ?? null) : null;
  if (input.reason === "trial" && trial === null) throw new BacktestRequestError("A trial needs a starting account.", 400);
  if (trial?.volFarmerV4) {
    const tried = await resolveAnalysisLabValues(normalizedAnalysisSymbol(input.symbol), trial, connection);
    const problem = mergedVolFarmerV4Problem(tried.effective.v4);
    if (problem) throw new BacktestRequestError(`The trial's values: ${problem}`, 400);
  }
  const symbol = await assertTickerCanBeAnalysed(input.symbol, trial === null ? "saved" : "trial", connection);
  const values = await resolveAnalysisLabValues(symbol, trial, connection);
  const { hash, ...labValues } = values;
  const ids = await connection.transaction(async (transaction) => {
    const jobId = await insertQueuedAnalysisJob(symbol, transaction);
    const [row] = await transaction("backtest_ticker_analyses")
      .insert({ symbol, job_id: jobId, status: "queued", formulas_version: analysisFormulasVersion, lab_values: JSON.stringify(labValues), lab_values_hash: hash, reason: input.reason, summary_status: "skipped" })
      .returning("id");
    return { analysisId: row.id as string, jobId };
  });
  await kickAnalysisQueue();
  return ids;
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
  figures_seconds: string | null;
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
    labValues: row.lab_values ? { ...row.lab_values, tickerValues: row.lab_values.tickerValues ?? null } : row.lab_values,
    // From the stored values, so a run saved before the hash covered only what an analysis reads compares alike.
    labValuesHash: row.lab_values ? hashAnalysisLabValues(row.lab_values) : row.lab_values_hash,
    optionLastDate: row.option_last_date,
    barsLastDate: row.bars_last_date,
    figuresSeconds: row.figures_seconds === null ? null : Number(row.figures_seconds),
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

const selectAnalyses = (connection: Knex) => connection("backtest_ticker_analyses as a").leftJoin("backtest_jobs as j", "j.id", "a.job_id");

/** The price chart's indicators (barIndicatorsOf) added to figures as they are read, so analyses already stored show them. */
function withBarIndicators<T>(figures: T): T {
  const bars = (figures as { bars?: AnalysisFigures["bars"] } | null)?.bars;
  if (!Array.isArray(bars)) return figures;
  return { ...figures, barIndicators: barIndicatorsOf(bars.map((bar) => ({ close: bar[4], impliedVolatility: bar[5] }))) };
}

/** Out of date: computed with other lab values than the lab's now, or with older formulas. */
const isOutOfDate = (view: Pick<AnalysisRunView, "labValuesHash" | "formulasVersion">, currentHash: string) => view.labValuesHash !== currentHash || view.formulasVersion < analysisFormulasVersion;

export interface TickerAnalysisView {
  symbol: string;
  /** The latest succeeded saved analysis, with its figures. */
  stored: (AnalysisRunView & { figures: unknown }) | null;
  /** The latest trial that succeeded after the stored one, with its figures. */
  trial: (AnalysisRunView & { figures: unknown }) | null;
  /** Analyses not finished yet (a saved one and a trial at most), and the latest that failed or stopped since the stored one. */
  active: AnalysisRunView[];
  latestProblem: AnalysisRunView | null;
  /** The lab's values now, and their hash: a stored analysis with another hash was computed with other values. */
  currentHash: string;
  /** The stored analysis was computed with other lab values, or older formulas. */
  outOfDate: boolean;
  /** The lab's last save. */
  labSavedAt: string;
  /** The ticker's own values (Save and Analyse keeps them); null when it has none. */
  tickerValues: StoredTickerOwnValues | null;
  /** The lab's five now: what each null of the ticker's own values reads. */
  labTickerFieldValues: TickerFieldValues;
  /** The file now runs past the stored analysis's last day. */
  fileLastDate: string | null;
  currentFormulasVersion: number;
  /** The header's name and classification; null when nothing is stored for the ticker. */
  profile: BacktestTickerProfile | null;
  /** As on the Data files table; null: Pending. */
  suitability: BacktestTickerSuitability | null;
  /** The symbol's splits over its daily bars, for the price chart's split lines; null before its file was analysed. */
  detectedSplits: BacktestDetectedSplit[] | null;
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
    const body = await connection("backtest_ticker_analyses").where({ id: view.id }).first("figures");
    return { ...view, figures: body?.figures == null ? null : withBarIndicators(body.figures) };
  };
  const [lab, own] = await Promise.all([loadBacktestLabSettings(connection), loadTickerOwnValues(symbol, connection)]);
  const current = analysisLabValuesOf(lab, own?.values ?? null, null);
  return {
    symbol,
    stored: await withBody(storedView),
    trial: await withBody(trialView),
    active: views.filter((view) => view.status === "queued" || view.status === "running"),
    latestProblem: views.find((view) => ["failed", "stopped"].includes(view.status) && view.reason !== "trial" && (!storedView || view.createdAt > storedView.createdAt)) ?? null,
    currentHash: current.hash,
    outOfDate: storedView !== null && isOutOfDate(storedView, current.hash),
    labSavedAt: lab.updatedAt,
    tickerValues: own,
    labTickerFieldValues: tickerFieldValuesOf(analysisVolFarmerV4Of({ settings: lab.settings, tickerValues: null, trial: null })),
    fileLastDate: readBacktestDataFileContents(symbol)?.lastDate ?? null,
    currentFormulasVersion: analysisFormulasVersion,
    profile: await loadTickerProfile(symbol, connection),
    suitability: await loadTickerSuitability(symbol, connection),
    detectedSplits: cachedSplitsBetween(readBacktestDataDirectory(), symbol, "0000-01-01", "9999-12-31"),
  };
}

/** The figures the data file gives without an analysis: the window before a ticker's first analysis. Nothing is stored. */
export async function loadAnalysisFileFigures(givenSymbol: string, connection: Knex = db): Promise<AnalysisFileFigures> {
  const symbol = normalizeBacktestSymbol(givenSymbol);
  const contents = readBacktestDataFileContents(symbol);
  if (!contents) throw new BacktestRequestError(`There is no data file for ${symbol}: download it first.`, 404);
  if (!contents.firstDate) throw new BacktestRequestError(`The ${symbol} data file has no complete days yet.`, 409);
  return withBarIndicators(await computeAnalysisFileFigures({ symbol, connection }));
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
  // A running one's process marks it cancelled; a queued or stopped one has no process to do it.
  if (run.status === "queued" || run.status === "stopped") await connection("backtest_ticker_analyses").where({ id: analysisId }).whereIn("status", ["queued", "running"]).update({ status: "cancelled", finished_at: connection.fn.now() });
  return loadTickerAnalysisRun(analysisId, connection);
}

/** The Data files table's figures of a finished analysis; null when its backtest failed. */
export function analysisTableFiguresOf(figures: AnalysisFigures, backtest: AnalysisBacktestFigures | null): AnalysisTableFigures | null {
  if (backtest === null) return null;
  const twelveMonths = backtest.rule.windows.find((window) => window.months === 12) ?? null;
  return {
    verdict: backtest.rule.verdict.suits ? "suits" : "doesnt_suit",
    failedChecks: backtest.rule.verdict.failedChecks,
    uncoveredWindows: backtest.rule.verdict.uncoveredWindows,
    optionsIncomeTwelveMonths: twelveMonths?.optionsIncome.yearlyShare ?? null,
    v4Cagr: backtest.metrics ? Number(backtest.metrics.cagr) : null,
    holdCagr: backtest.buyAndHoldMetrics ? Number(backtest.buyAndHoldMetrics.cagr) : null,
    v4ExcessCalmar: backtest.excessCalmar.v4,
    holdExcessCalmar: backtest.excessCalmar.hold,
    smallestPotDollars: figures.size.smallestPotDollars,
  };
}

export interface AnalysisTableRow {
  status: AnalysisRunView["status"];
  finishedAt: string | null;
  optionLastDate: string | null;
  formulasVersion: number;
  outOfDate: boolean;
  /** The latest succeeded saved analysis's figures; null before one, or when its backtest failed. */
  tableFigures: AnalysisTableFigures | null;
  /** When the latest saved analysis is running or failed: when the one the figures are from finished. */
  figuresFinishedAt: string | null;
}

/**
 * For the Data files table: each symbol's latest saved analysis, its figures, and whether it is out of date (against the
 * lab with the symbol's own values on top); every ticker's own values and the lab's five, for the Own values tag.
 */
export async function loadAnalysesForTable(connection: Knex = db): Promise<{ labSavedAt: string; outOfDate: string[]; bySymbol: Record<string, AnalysisTableRow>; tickerValuesBySymbol: Record<string, StoredTickerOwnValues>; labTickerFieldValues: TickerFieldValues }> {
  const latest: AnalysisRow[] = await selectAnalyses(connection)
    .distinctOn("a.symbol")
    .whereNot("a.reason", "trial")
    .orderBy([{ column: "a.symbol" }, { column: "a.created_at", order: "desc" }])
    .select(analysisColumns(connection));
  const succeeded: (AnalysisRow & { table_figures: AnalysisTableFigures | null })[] = await selectAnalyses(connection)
    .distinctOn("a.symbol")
    .whereNot("a.reason", "trial")
    .where("a.status", "succeeded")
    .orderBy([{ column: "a.symbol" }, { column: "a.created_at", order: "desc" }])
    .select([...analysisColumns(connection), "a.table_figures"]);
  const [lab, tickerValuesBySymbol] = await Promise.all([loadBacktestLabSettings(connection), loadAllTickerOwnValues(connection)]);
  const currentHashOf = (symbol: string) => analysisLabValuesOf(lab, tickerValuesBySymbol[symbol]?.values ?? null, null).hash;
  const now = new Date();
  const succeededBySymbol = new Map(succeeded.map((row) => [row.symbol, { view: toRunView(row, now), tableFigures: row.table_figures }]));
  const bySymbol: Record<string, AnalysisTableRow> = {};
  for (const row of latest) {
    const view = toRunView(row, now);
    const done = succeededBySymbol.get(view.symbol) ?? null;
    bySymbol[view.symbol] = {
      status: view.status,
      finishedAt: view.finishedAt,
      optionLastDate: done?.view.optionLastDate ?? view.optionLastDate,
      formulasVersion: done?.view.formulasVersion ?? view.formulasVersion,
      outOfDate: done !== null && isOutOfDate(done.view, currentHashOf(view.symbol)),
      tableFigures: done?.view.formulasVersion === analysisFormulasVersion ? done.tableFigures : null,
      figuresFinishedAt: done?.view.finishedAt ?? null,
    };
  }
  const outOfDate = Object.entries(bySymbol).filter(([, row]) => row.outOfDate && row.status !== "queued" && row.status !== "running").map(([symbol]) => symbol);
  return { labSavedAt: lab.updatedAt, outOfDate, bySymbol, tickerValuesBySymbol, labTickerFieldValues: tickerFieldValuesOf(analysisVolFarmerV4Of({ settings: lab.settings, tickerValues: null, trial: null })) };
}

/** Re-run out of date: starts a saved analysis of every symbol whose stored one is out of date (none running); the rest are listed with why. */
export async function rerunOutOfDateAnalyses(connection: Knex = db): Promise<{ started: string[]; skipped: { symbol: string; reason: string }[] }> {
  const { outOfDate } = await loadAnalysesForTable(connection);
  const started: string[] = [];
  const skipped: { symbol: string; reason: string }[] = [];
  for (const symbol of outOfDate) {
    try {
      await startTickerAnalysis({ symbol, reason: "global_settings" }, connection);
      started.push(symbol);
    } catch (error) {
      skipped.push({ symbol, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { started, skipped };
}
