import { describe, expect, it, vi } from "vitest";
import type { GenosukeApiClient } from "../apiClient.js";
import { lowStakesWriteTools } from "./lowStakesWriteTools.js";

// Audit (G2, 2026-10-07): Genosuke's shortlist write tools after the notes column was dropped.
function toolNamed(name: string) {
  const tool = lowStakesWriteTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe("shortlist write tools", () => {
  it("no tool mentions or sends notes any more", () => {
    for (const tool of lowStakesWriteTools) {
      expect(JSON.stringify(tool.parameters)).not.toMatch(/notes/i);
      expect(tool.name).not.toMatch(/notes/);
    }
  });

  it("add_shortlist_ticker takes only the symbol and no longer asks for a strategy", () => {
    const parameters = toolNamed("add_shortlist_ticker").parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(Object.keys(parameters.properties)).toEqual(["symbol"]);
    expect(parameters.required).toEqual(["symbol"]);
  });
});
