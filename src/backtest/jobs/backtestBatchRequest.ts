// POST /backtest/batches (Marcelo 2026-10-17): the New session form's request, checked for its own shape here; its run is
// then checked as a session request (labSessionRequest.ts). A batch holds one run since the CC + Put Ladder, whose runs
// they were, retired (2026-11-02); past batches keep their runs. Pure.

const maximumNameLength = 120;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A batch request's shape: the name, the runs, and every other field as each run's session request takes it. */
export interface BatchRequestShape {
  name: string;
  /** The session request of each run, without its name. */
  runBodies: Record<string, unknown>[];
  labels: (string | null)[];
}

/**
 * A run's session name: the batch's name alone for a single run, else "<name> · Run 2 · <label>", cut to 120 characters
 * (the session name's limit) with an ellipsis.
 */
export function batchRunSessionName(batchName: string, runNumber: number, runCount: number, label: string | null): string {
  if (runCount === 1) return batchName;
  const full = [batchName, `Run ${runNumber}`, label].filter((part) => part !== null && part !== "").join(" · ");
  return full.length <= maximumNameLength ? full : `${full.slice(0, maximumNameLength - 1).trimEnd()}…`;
}

export function validateBatchRequestShape(body: unknown): { ok: true; value: BatchRequestShape } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: "The request body must be an object." };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") return { ok: false, error: "Give the batch a name." };
  if (name.length > maximumNameLength) return { ok: false, error: `The name can be at most ${maximumNameLength} characters.` };
  const runs = body.runs;
  if (!Array.isArray(runs) || runs.length === 0) return { ok: false, error: "Give the batch at least one run." };
  if (runs.length > 1) return { ok: false, error: "A batch holds one run: several runs were the CC + Put Ladder's, retired on 2 Nov 2026." };

  const shared: Record<string, unknown> = { ...body };
  delete shared.runs;
  delete shared.name;
  const runBodies: Record<string, unknown>[] = [];
  const labels: (string | null)[] = [];
  for (const run of runs) {
    if (!isPlainObject(run)) return { ok: false, error: "The run must be an object." };
    const unknownKey = Object.keys(run).find((key) => key !== "label" && key !== "symbols");
    if (unknownKey) return { ok: false, error: `The run: ${unknownKey} is not a run field (label or symbols).` };
    if (run.label !== undefined && run.label !== null && typeof run.label !== "string") return { ok: false, error: "The run: label must be text." };
    labels.push(typeof run.label === "string" && run.label.trim() !== "" ? run.label.trim() : null);
    runBodies.push({ ...shared, symbols: run.symbols });
  }
  return { ok: true, value: { name, runBodies, labels } };
}
