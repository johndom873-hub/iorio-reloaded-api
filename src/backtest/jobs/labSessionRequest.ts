import { readBacktestDataFileContents, readBacktestDataFilePeriodContents } from "../dataFileSummary.js";
import { editableBacktestSettingPaths } from "../settingsTemplate.js";
import { loadBacktestLabSettings } from "../labSettingsStore.js";
import { BacktestRequestError } from "./backtestJobStore.js";
import { batchRunSessionName, validateBatchRequestShape } from "./backtestBatchRequest.js";
import { validateCreateBacktestSessionRequest } from "./backtestSessionRequest.js";

// A New session request checked against the lab's settings (Marcelo 2026-10-15: new sessions start from the lab's
// values, never from Pluto's live settings), as the create route and the analysis job both create sessions. Answers the
// snapshot the session freezes, the validated request and its warnings.
export async function validateSessionRequestAgainstLab(body: unknown) {
  const lab = await loadBacktestLabSettings();
  const snapshot = lab.settings;
  const validation = validateCreateBacktestSessionRequest(body, {
    snapshot,
    editablePaths: editableBacktestSettingPaths,
    coverageFor: (symbol) => readBacktestDataFileContents(symbol),
    periodContentsFor: (symbol, startDate, endDate) => readBacktestDataFilePeriodContents(symbol, startDate, endDate),
  });
  if (!validation.ok) throw new BacktestRequestError(validation.error, 400);
  return { snapshot, value: validation.value, warnings: validation.warnings };
}

/**
 * A batch request (POST /backtest/batches) checked as one session request against the lab. Several runs were the CC +
 * Put Ladder's (its per-ticker values varied run by run), retired on 2 Nov 2026: a batch holds one run.
 */
export async function validateBatchRequestAgainstLab(body: unknown) {
  const shape = validateBatchRequestShape(body);
  if (!shape.ok) throw new BacktestRequestError(shape.error, 400);
  const { name, runBodies, labels } = shape.value;
  const run = await validateSessionRequestAgainstLab({ ...runBodies[0]!, name: batchRunSessionName(name, 1, 1, labels[0]!) });
  return { name, runs: [run], warnings: run.warnings };
}
