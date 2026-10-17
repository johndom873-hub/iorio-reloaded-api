import { readBacktestDataFileContents, readBacktestDataFilePeriodContents } from "../dataFileSummary.js";
import { editableBacktestSettingPaths } from "../settingsTemplate.js";
import { loadBacktestLabSettings, loadBacktestLabTickerOverrides, tickerOverridesToValues } from "../labSettingsStore.js";
import { readBacktestClaudeCliPath } from "../backtestClaudeCli.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { lookTimesInWindow, regularCloseMinutesEt } from "../engine/runBacktestSession.js";
import { estimateLlmSession } from "../llm/estimateLlmSession.js";
import { BacktestRequestError } from "./backtestJobStore.js";
import { batchRunSessionName, validateBatchRequestShape } from "./backtestBatchRequest.js";
import { validateCreateBacktestSessionRequest } from "./backtestSessionRequest.js";

// A New session request checked against the lab's settings (Marcelo 2026-10-15: new sessions start from the lab's global
// values and each ticker's lab values, never from Pluto's live settings), as the create route and the analysis job both
// create sessions. Answers the snapshot the session freezes, the validated request, its warnings and, with the AI model
// deciding, the estimate of its calls.
export async function validateSessionRequestAgainstLab(body: unknown) {
  const checked = await checkSessionRequestAgainstLab(body);
  if (checked.kind === "ticker_problems") throw new BacktestRequestError(checked.error, 400);
  return checked;
}

/**
 * A batch request (POST /backtest/batches) checked run by run as session requests against the lab. Every problem is
 * listed, "Run 2: …" with two or more runs; two or more runs need the baseline deciding. Answers each run's checked
 * request, the warnings (named by run with two or more) and, for a single run with the AI model, its estimate.
 */
export async function validateBatchRequestAgainstLab(body: unknown) {
  const shape = validateBatchRequestShape(body);
  if (!shape.ok) throw new BacktestRequestError(shape.error, 400);
  const { name, runBodies, labels } = shape.value;
  const runCount = runBodies.length;
  const checked = await Promise.all(
    runBodies.map(async (runBody, index) => {
      try {
        return { ok: true as const, result: await validateSessionRequestAgainstLab({ ...runBody, name: batchRunSessionName(name, index + 1, runCount, labels[index]!) }) };
      } catch (error) {
        if (error instanceof BacktestRequestError) return { ok: false as const, error: error.message };
        throw error;
      }
    }),
  );
  const named = (index: number, text: string) => (runCount === 1 ? text : `Run ${index + 1}: ${text}`);
  const problems = checked.flatMap((run, index) => (run.ok ? [] : [named(index, run.error)]));
  for (const [index, run] of checked.entries()) {
    if (run.ok && runCount > 1 && run.result.value.bookMode !== "pots") problems.push(named(index, "several runs need the Baseline as decision maker."));
  }
  if (problems.length > 0) throw new BacktestRequestError(problems.join(" "), 400);
  const runs = checked.map((run) => (run as Extract<typeof run, { ok: true }>).result);
  return {
    name,
    runs,
    warnings: runs.flatMap((run, index) => run.warnings.map((warning) => named(index, warning))),
    llmEstimate: runCount === 1 ? runs[0]!.llmEstimate : null,
  };
}

/**
 * The same check for the New session screen's estimate: a request refused only for its tickers' values answers their
 * resolution (each ticker with its problems) instead of an error, so the screen can show every problem at once.
 */
export async function checkSessionRequestAgainstLab(body: unknown) {
  const [lab, tickerOverrides] = await Promise.all([loadBacktestLabSettings(), loadBacktestLabTickerOverrides()]);
  const snapshot = lab.settings;
  const tickerValues = new Map(tickerOverrides.map((row) => [row.symbol, tickerOverridesToValues(row)]));
  const validation = validateCreateBacktestSessionRequest(body, {
    snapshot,
    editablePaths: editableBacktestSettingPaths,
    coverageFor: (symbol) => readBacktestDataFileContents(symbol),
    periodContentsFor: (symbol, startDate, endDate) => readBacktestDataFilePeriodContents(symbol, startDate, endDate),
    claudeCliAvailable: readBacktestClaudeCliPath() !== null,
    tickerValuesFor: (symbol) => tickerValues.get(symbol) ?? null,
    defaultPotDollars: lab.defaultPotDollars,
  });
  if (!validation.ok) {
    if (validation.symbolResolution) return { kind: "ticker_problems" as const, tickerProblems: validation.symbolResolution, error: validation.error, warnings: validation.warnings ?? [] };
    throw new BacktestRequestError(validation.error, 400);
  }
  // With the AI model deciding, the calls a full day of looks may take (a day without intraday quotes has one look).
  const effective = applyBacktestOverrides(snapshot, validation.value.overrides);
  const llmEstimate =
    effective.decisionMaker === "llm"
      ? estimateLlmSession(validation.value.startDate, validation.value.endDate, lookTimesInWindow(effective.pluto.windowStartEt, effective.pluto.windowEndEt, regularCloseMinutesEt).length)
      : null;
  return { kind: "valid" as const, snapshot, value: validation.value, warnings: validation.warnings, llmEstimate };
}
