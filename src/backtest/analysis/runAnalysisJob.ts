import { db } from "../../db/connection.js";
import { readBacktestDataFileContents, readBacktestDataFilePeriodContents } from "../dataFileSummary.js";
import { createBacktestSession } from "../jobs/backtestSessionStore.js";
import { cancelBacktestJob } from "../jobs/backtestJobStore.js";
import { deriveJobDisplayStatus } from "../jobs/backtestJobRules.js";
import { validateSessionRequestAgainstLab } from "../jobs/labSessionRequest.js";
import { analysisSessionName, computeAnalysisBacktestFigures, type AnalysisBacktestFigures } from "./analysisBacktest.js";
import { refreshTickerProfiles } from "../tickerProfileStore.js";
import { analysisFormulasVersion, computeAnalysisFigures, type AnalysisFigures, type AnalysisStep } from "./analysisFigures.js";
import { listAnalysisSessions } from "./analysisSessions.js";
import type { AnalysisLabValues, AnalysisReason } from "./analysisStore.js";
import { analysisSummaryPromptVersion, buildAnalysisSummaryDigest, writeAnalysisSummary } from "./analysisSummary.js";

// The "analysis" job (scripts/run-backtest-job.ts): the figures, then (a saved analysis only) the ticker's backtest at
// its lab values as an ordinary session, waited for, and its order records; then Claude's summary. Progress reports the
// step as the job's label (analysisSteps), the chain scan's days and the backtest's days as done/total.

export interface AnalysisJobControl {
  readonly cancelRequested: boolean;
  readonly ownershipLost: boolean;
  reportProgress(done: number, total: number, label: string | null): Promise<void>;
  onCancel(listener: () => void): () => void;
}

export type StoredAnalysisFigures = AnalysisFigures & { analysisBacktest: AnalysisBacktestFigures | { error: string } | null };

export class AnalysisCancelledError extends Error {}

const backtestPollMilliseconds = 3_000;

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

/** Creates the analysis's backtest session (the lab's values, the ticker's overrides, the file's whole period) and waits for it. */
async function runAnalysisBacktest(symbol: string, labValues: AnalysisLabValues, analysisId: string, control: AnalysisJobControl): Promise<AnalysisBacktestFigures | { error: string }> {
  const contents = readBacktestDataFileContents(symbol);
  if (!contents?.firstDate || !contents.lastDate) return { error: "The data file has no complete days." };
  const { baseline, potDollars } = labValues.effective;
  let request: Awaited<ReturnType<typeof validateSessionRequestAgainstLab>>;
  try {
    request = await validateSessionRequestAgainstLab({
      name: analysisSessionName(symbol, potDollars, baseline),
      symbols: [symbol],
      startDate: contents.firstDate,
      endDate: contents.lastDate,
      tablesMode: "walk_forward",
      settingsSource: "per_ticker",
      // The analysis is the CC + Put Ladder's: the baseline decides even when the lab's decision maker is another.
      overrides: labValues.settings.decisionMaker === "baseline" ? {} : { decisionMaker: "baseline" },
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
  return computeAnalysisBacktestFigures(session.id, symbol);
}

/**
 * The session of an earlier saved analysis at the same values over the same data, still there and finished: running it
 * again would give the same backtest, so its figures are read again instead (Fetch earnings, an Update with nothing new).
 * Only from an analysis of the same formulas version: a new version may need records older sessions lack.
 */
async function reusableAnalysisSession(analysisId: string, symbol: string, labValuesHash: string, optionLastDate: string, barsLastDate: string | null): Promise<string | null> {
  const row: { session_id: string } | undefined = await db("backtest_ticker_analyses as a")
    .join("backtest_sessions as s", "s.id", "a.session_id")
    .where({ "a.symbol": symbol, "a.lab_values_hash": labValuesHash, "a.option_last_date": optionLastDate, "a.formulas_version": analysisFormulasVersion, "s.status": "succeeded" })
    .whereNot("a.id", analysisId)
    .whereNot("a.reason", "trial")
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

    if (analysis.reason !== "trial") {
      await control.reportProgress(0, 0, "backtest" satisfies AnalysisStep);
      const reusedSessionId = await reusableAnalysisSession(analysis.id, analysis.symbol, analysis.lab_values_hash, figures.optionLastDate, figures.barsLastDate);
      if (reusedSessionId) await db("backtest_ticker_analyses").where({ id: analysis.id }).update({ session_id: reusedSessionId });
      stored.analysisBacktest = reusedSessionId
        ? await computeAnalysisBacktestFigures(reusedSessionId, analysis.symbol)
        : await runAnalysisBacktest(analysis.symbol, analysis.lab_values, analysis.id, control);
      await db("backtest_ticker_analyses").where({ id: analysis.id }).update({ figures: JSON.stringify(stored) });
    }
    if (control.cancelRequested) throw new AnalysisCancelledError();

    await control.reportProgress(0, 0, "summary" satisfies AnalysisStep);
    const backtest = stored.analysisBacktest && "sessionId" in stored.analysisBacktest ? stored.analysisBacktest : null;
    // The data file's missing weekdays over the last 12 months (the window after the same date a year before), for the verdict's first test.
    const yearBefore = `${Number(figures.optionLastDate.slice(0, 4)) - 1}${figures.optionLastDate.slice(4)}`;
    const lastTwelveMonthsFrom = new Date(Date.parse(`${yearBefore}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const lastTwelveMonths = readBacktestDataFilePeriodContents(analysis.symbol, lastTwelveMonthsFrom, figures.optionLastDate);
    const digest = buildAnalysisSummaryDigest({ figures, values: analysis.lab_values.effective, backtest, sessions: await listAnalysisSessions(analysis.symbol), missingWeekdaysLastTwelveMonths: lastTwelveMonths?.missingWeekdays ?? null });
    const outcome = await writeAnalysisSummary(digest);
    const call = "call" in outcome ? outcome.call : null;
    await finish({
      status: "succeeded",
      summary_status: outcome.status,
      summary: outcome.status === "written" ? JSON.stringify(outcome.summary) : null,
      summary_error: outcome.status === "written" ? null : outcome.error,
      summary_model: call?.servedModelId ?? null,
      summary_prompt_version: analysisSummaryPromptVersion,
      summary_tokens_in: call?.tokensIn ?? null,
      summary_tokens_out: call?.tokensOut ?? null,
      summary_cost_usd: call?.costUsd ?? null,
      summary_latency_ms: call?.latencyMs ?? null,
      summary_raw_output: call?.rawText ?? null,
    });
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
