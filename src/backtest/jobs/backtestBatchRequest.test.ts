import { describe, expect, it } from "vitest";
import { batchRunSessionName, validateBatchRequestShape } from "./backtestBatchRequest.js";

describe("batch run session names", () => {
  it("is the batch's name for a single run, else the name, the run and its label", () => {
    expect(batchRunSessionName("CRWV ladder", 1, 1, "share level 30%")).toBe("CRWV ladder");
    expect(batchRunSessionName("CRWV ladder", 2, 4, "share level 50%")).toBe("CRWV ladder · Run 2 · share level 50%");
    expect(batchRunSessionName("CRWV ladder", 3, 4, null)).toBe("CRWV ladder · Run 3");
  });

  it("is cut to 120 characters with an ellipsis", () => {
    const name = batchRunSessionName("A".repeat(100), 9, 9, "CRWV, NBIS · CRWV share level 50% · NBIS rungs 3");
    expect(name).toHaveLength(120);
    expect(name.endsWith("…")).toBe(true);
    expect(name.startsWith(`${"A".repeat(100)} · Run 9 · `)).toBe(true);
  });
});

describe("batch request shape", () => {
  it("gives the run the shared fields with its own symbols", () => {
    const checked = validateBatchRequestShape({ name: " Batch ", startDate: "2026-01-02", endDate: "2026-06-30", tablesMode: "walk_forward", overrides: { decisionMaker: "vol_farmer_v4" }, runs: [{ label: "a", symbols: ["CRWV"] }] });
    expect(checked).toEqual({
      ok: true,
      value: { name: "Batch", labels: ["a"], runBodies: [{ startDate: "2026-01-02", endDate: "2026-06-30", tablesMode: "walk_forward", overrides: { decisionMaker: "vol_farmer_v4" }, symbols: ["CRWV"] }] },
    });
  });

  it("refuses several runs, which were the CC + Put Ladder's, and a field that is not a run's", () => {
    expect(validateBatchRequestShape({ name: "B", runs: [{ symbols: ["A"] }, { symbols: ["B"] }] })).toEqual({ ok: false, error: "A batch holds one run: several runs were the CC + Put Ladder's, retired on 2 Nov 2026." });
    expect(validateBatchRequestShape({ name: "B", runs: [{ symbols: ["A"], symbolSettings: {} }] })).toEqual({ ok: false, error: "The run: symbolSettings is not a run field (label or symbols)." });
    expect(validateBatchRequestShape({ name: "B", runs: [{ symbols: ["A"], label: 3 }] })).toEqual({ ok: false, error: "The run: label must be text." });
    expect(validateBatchRequestShape({ name: " ", runs: [{ symbols: ["A"] }] })).toEqual({ ok: false, error: "Give the batch a name." });
  });
});
