import { describe, expect, it, vi } from "vitest";
import type { GenosukeApiClient } from "../apiClient.js";
import { readTools } from "./readTools.js";

// Audit (G2, 2026-10-07): list_shortlist after the shortlist lost its per-strategy meaning (Signals switch, notes removed).
// GET /shortlist ignores any strategy query (routes/shortlist.ts reads no query parameter), so the tool must not make the model pick one.
function listShortlistTool() {
  const tool = readTools.find((candidate) => candidate.name === "list_shortlist");
  if (!tool) throw new Error("no list_shortlist tool");
  return tool;
}

describe("list_shortlist", () => {
  it("describes the Signals and Pluto flags it returns", () => {
    expect(listShortlistTool().description).toMatch(/signalsEnabled/);
    expect(listShortlistTool().description).toMatch(/botEnabled/);
  });

  it("does not require a strategy the route ignores", () => {
    const parameters = listShortlistTool().parameters as { required?: string[] };
    expect(parameters.required ?? []).not.toContain("strategyKey");
  });

  it("works when the model passes no strategy at all", async () => {
    const get = vi.fn(async () => []);
    await listShortlistTool().execute({}, { get } as unknown as GenosukeApiClient);
    expect(get).toHaveBeenCalledWith(expect.not.stringContaining("undefined"));
  });
});
