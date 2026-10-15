import { readBacktestDataFileContents, readBacktestDataFilePeriodContents } from "../dataFileSummary.js";
import { editableBacktestSettingPaths } from "../settingsTemplate.js";
import { loadBacktestLabSettings, loadBacktestLabTickerOverrides, tickerOverridesToValues } from "../labSettingsStore.js";
import { readBacktestClaudeCliPath } from "../backtestClaudeCli.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { lookTimesInWindow, regularCloseMinutesEt } from "../engine/runBacktestSession.js";
import { estimateLlmSession } from "../llm/estimateLlmSession.js";
import { BacktestRequestError } from "./backtestJobStore.js";
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
