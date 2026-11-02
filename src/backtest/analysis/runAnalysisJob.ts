import { db } from "../../db/connection.js";
import { readBacktestDataFileContents } from "../dataFileSummary.js";
import { createBacktestSession } from "../jobs/backtestSessionStore.js";
import { cancelBacktestJob } from "../jobs/backtestJobStore.js";
import { deriveJobDisplayStatus } from "../jobs/backtestJobRules.js";
import { validateSessionRequestAgainstLab } from "../jobs/labSessionRequest.js";
import { analysisSessionName, computeAnalysisBacktestFigures, type AnalysisBacktestFigures } from "./analysisBacktest.js";
import { refreshTickerProfiles } from "../tickerProfileStore.js";
import { analysisFormulasVersion, computeAnalysisFigures, type AnalysisFigures, type AnalysisStep } from "./analysisFigures.js";
import { analysisTableFiguresOf, type AnalysisLabValues, type AnalysisReason } from "./analysisStore.js";

// The "analysis" job (scripts/run-backtest-job.ts): the figures, then the ticker's Vol Farmer v4 backtest at the lab's
// values (or a trial's starting account) as an ordinary session, waited for, and its records; then the Data files table's
// figures. Progress reports the step as the job's label (analysisSteps), the scan's days and the backtest's days as
// done/total. No summary is written since v4 (Marcelo 2026-11-01: the verdict is the rule's).

export interface AnalysisJobControl {
  readonly cancelRequested: boolean;
  readonly ownershipLost: boolean;
  reportProgress(done: number, total: number, label: string | null): Promise<void>;
  onCancel(listener: () => void): () => void;
}

export type StoredAnalysisFigures = AnalysisFigures & { analysisBacktest: AnalysisBacktestFigures | { error: string } | null };

export class AnalysisCancelledError extends Error {}

const backtestPollMilliseconds = 3_000;

/** The file's daily bars as split-adjusted closes (each wheel cycle's stock change). */
const closesOf = (figures: Pick<AnalysisFigures, "bars">) => figures.bars.map(([tradingDate, , , , close]) => ({ tradingDate, close }));

function waitOrCancel(milliseconds: number, control: AnalysisJobControl): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve();
    }, milliseconds);
    const stop = control.onCancel(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Creates the analysis's backtest session and waits for it: the ticker alone under Vol Farmer v4 at the lab's values, from
 * the steady-weeklies start (F1) to the file's last day, on the lab's default account or a trial's.
 */
async function runAnalysisBacktest(symbol: string, labValues: AnalysisLabValues, figures: AnalysisFigures, analysisId: string, control: AnalysisJobControl): Promise<AnalysisBacktestFigures | { error: string }> {
  const contents = readBacktestDataFileContents(symbol);
  if (!contents?.firstDate || !contents.lastDate) return { error: "The data file has no complete days." };
  // The analysis is Vol Farmer v4's: v4 decides even when the lab's decision maker is another.
  const overrides: Record<string, unknown> = labValues.settings.decisionMaker === "vol_farmer_v4" ? {} : { decisionMaker: "vol_farmer_v4" };
  let request: Awaited<ReturnType<typeof validateSessionRequestAgainstLab>>;
  try {
    request = await validateSessionRequestAgainstLab({
      name: analysisSessionName(symbol, labValues.effective.accountDollars, labValues.trial !== null),
      symbols: [symbol],
      startDate: figures.expiryWeeks.backtestStartDate,
      endDate: contents.lastDate,
      tablesMode: "walk_forward",
      startingValue: labValues.effective.accountDollars,
      overrides,
    });
  } catch (error) {
    return { error: `The backtest could not start: ${error instanceof Error ? error.message : String(error)}` };
  }
  const { session, job } = await createBacktestSession(request.value, request.snapshot);
  await db("backtest_ticker_analyses").where({ id: analysisId }).update({ session_id: session.id });
  while (true) {
    if (control.cancelRequested) {
      await cancelBacktestJob(job.id).catch(() => undefined);
      throw new AnalysisCancelledError();
    }
    const row: { status: string; heartbeat_at: Date | null; progress_done: number; progress_total: number } | undefined = await db("backtest_jobs").where({ id: job.id }).first("status", "heartbeat_at", "progress_done", "progress_total");
    if (!row) return { error: "The backtest's job was deleted." };
    const status = deriveJobDisplayStatus(row.status as never, row.heartbeat_at ? new Date(row.heartbeat_at) : null, new Date());
    if (status === "succeeded") break;
    if (status === "failed" || status === "cancelled" || status === "stopped") return { error: `The backtest ${status === "stopped" ? "stopped reporting" : status}.` };
    await control.reportProgress(Number(row.progress_done), Number(row.progress_total), "backtest" satisfies AnalysisStep);
    await waitOrCancel(backtestPollMilliseconds, control);
  }
  return computeAnalysisBacktestFigures(session.id, symbol, figures.falls, closesOf(figures));
}

/**
 * The session of an earlier analysis at the same values over the same data, still there and finished: running it again
 * would give the same backtest, so its figures are read again instead (Fetch earnings, a Re-run with nothing new). Only
 * from an analysis of the same formulas version: a new version may need records older sessions lack.
 */
async function reusableAnalysisSession(analysisId: string, symbol: string, labValuesHash: string, optionLastDate: string, barsLastDate: string | null): Promise<string | null> {
  const row: { session_id: string } | undefined = await db("backtest_ticker_analyses as a")
    .join("backtest_sessions as s", "s.id", "a.session_id")
    .where({ "a.symbol": symbol, "a.lab_values_hash": labValuesHash, "a.option_last_date": optionLastDate, "a.formulas_version": analysisFormulasVersion, "s.status": "succeeded" })
    .whereNot("a.id", analysisId)
    .where((inner) => (barsLastDate === null ? inner.whereNull("a.bars_last_date") : inner.where("a.bars_last_date", barsLastDate)))
    .orderBy("a.created_at", "desc")
    .first("a.session_id");
  return row?.session_id ?? null;
}

export async function runAnalysisJob(jobId: string, control: AnalysisJobControl): Promise<{ status: "succeeded" | "failed" | "cancelled"; error: string | null }> {
  const analysis: { id: string; symbol: string; lab_values: AnalysisLabValues; lab_values_hash: string; reason: AnalysisReason } | undefined = await db("backtest_ticker_analyses").where({ job_id: jobId }).first("id", "symbol", "lab_values", "lab_values_hash", "reason");
  if (!analysis) return { status: "failed", error: "This analysis job has no analysis." };
  const finish = async (columns: Record<string, unknown>) => {
    if (!control.ownershipLost) await db("backtest_ticker_analyses").where({ id: analysis.id }).update({ ...columns, finished_at: db.fn.now() });
  };
  await db("backtest_ticker_analyses").where({ id: analysis.id }).update({ status: "running" });
  // The header's name and classification: kept from the last time when TradingView doesn't answer, never failing the analysis.
  void refreshTickerProfiles([analysis.symbol]).catch((error: unknown) => console.warn(`Analysis ${analysis.symbol}: TradingView profile not refreshed:`, error instanceof Error ? error.message : error));
  try {
    const started = Date.now();
    const figures = await computeAnalysisFigures({
      symbol: analysis.symbol,
      values: analysis.lab_values.effective,
      onProgress: ({ step, done, total }) => void control.reportProgress(done, total, step),
    });
    if (control.cancelRequested) throw new AnalysisCancelledError();
    await control.reportProgress(0, 0, "saving" satisfies AnalysisStep);
    const stored: StoredAnalysisFigures = { ...figures, analysisBacktest: null };
    const contents = readBacktestDataFileContents(analysis.symbol);
    await db("backtest_ticker_analyses")
      .where({ id: analysis.id })
      .update({
        figures: JSON.stringify(stored),
        figures_seconds: (Date.now() - started) / 1000,
        option_last_date: figures.optionLastDate,
        bars_last_date: figures.barsLastDate,
        file_fingerprint: JSON.stringify({ completeDays: contents?.completeDays ?? null, lastOptionDate: figures.optionLastDate, barCount: figures.bars.length, lastBarDate: figures.barsLastDate }),
      });

    await control.reportProgress(0, 0, "backtest" satisfies AnalysisStep);
    const reusedSessionId = await reusableAnalysisSession(analysis.id, analysis.symbol, analysis.lab_values_hash, figures.optionLastDate, figures.barsLastDate);
    if (reusedSessionId) await db("backtest_ticker_analyses").where({ id: analysis.id }).update({ session_id: reusedSessionId });
    stored.analysisBacktest = reusedSessionId ? await computeAnalysisBacktestFigures(reusedSessionId, analysis.symbol, figures.falls, closesOf(figures)) : await runAnalysisBacktest(analysis.symbol, analysis.lab_values, figures, analysis.id, control);
    if (control.cancelRequested) throw new AnalysisCancelledError();
    const backtest = stored.analysisBacktest && "sessionId" in stored.analysisBacktest ? stored.analysisBacktest : null;
    await finish({ status: "succeeded", figures: JSON.stringify(stored), table_figures: JSON.stringify(analysisTableFiguresOf(figures, backtest)), summary_status: "skipped" });
    return { status: "succeeded", error: null };
  } catch (error) {
    if (error instanceof AnalysisCancelledError || control.cancelRequested) {
      await finish({ status: "cancelled", summary_status: "skipped" });
      return { status: "cancelled", error: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Analysis ${analysis.id} (${analysis.symbol}) failed:`, error);
    await finish({ status: "failed", error: message, summary_status: "skipped" });
    return { status: "failed", error: message };
  }
}
