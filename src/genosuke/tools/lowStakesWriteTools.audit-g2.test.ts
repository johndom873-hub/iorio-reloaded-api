import { describe, expect, it, vi } from "vitest";
import type { GenosukeApiClient } from "../apiClient.js";
import { lowStakesWriteTools } from "./lowStakesWriteTools.js";

// Audit (G2, 2026-10-07): Genosuke's shortlist write tools after the notes column was dropped and the Signals switch added.
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

  it("add_shortlist_ticker offers signalsEnabled as a boolean and no longer asks for a strategy", () => {
    const parameters = toolNamed("add_shortlist_ticker").parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(parameters.properties.signalsEnabled).toEqual({ type: "boolean" });
    expect(parameters.properties).not.toHaveProperty("strategyKey");
    expect(parameters.required).toEqual(["symbol"]);
  });

  it("add_shortlist_ticker forwards the model's input as is (a stray string 'true' reaches the route, which answers 400)", async () => {
    const post = vi.fn(async () => {
      throw new Error("400 signalsEnabled must be true or false.");
    });
    await expect(toolNamed("add_shortlist_ticker").execute({ symbol: "MU", signalsEnabled: "true" }, { post } as unknown as GenosukeApiClient)).rejects.toThrow(/signalsEnabled/);
    expect(post).toHaveBeenCalledWith("/shortlist", { symbol: "MU", signalsEnabled: "true" });
  });

  it("add_shortlist_ticker without signalsEnabled sends none, so the route's default (off) applies", async () => {
    const post = vi.fn(async () => ({}));
    await toolNamed("add_shortlist_ticker").execute({ symbol: "MU" }, { post } as unknown as GenosukeApiClient);
    expect(post).toHaveBeenCalledWith("/shortlist", { symbol: "MU" });
  });
});
