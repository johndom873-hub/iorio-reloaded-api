import { describe, expect, it, vi } from "vitest";
import type { GenosukeApiClient } from "../apiClient.js";
import { lowStakesWriteTools } from "./lowStakesWriteTools.js";

function fakeApi() {
  const post = vi.fn(async () => ({ posted: true }));
  const patch = vi.fn(async () => ({ patched: true }));
  const remove = vi.fn(async () => undefined);
  const get = vi.fn();
  const put = vi.fn();
  return { api: { post, patch, delete: remove, get, put } as unknown as GenosukeApiClient, post, patch, remove, get, put };
}

function toolNamed(name: string) {
  const tool = lowStakesWriteTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe("the low-stakes write tool set", () => {
  it("lists the four tools, all in the low-stakes tier, with unique names", () => {
    expect(lowStakesWriteTools.map((tool) => tool.name)).toEqual([
      "add_shortlist_ticker",
      "trigger_ibkr_health_check",
      "save_preference",
      "forget_preference",
    ]);
    expect(lowStakesWriteTools.every((tool) => tool.tier === "low-stakes-write")).toBe(true);
  });

  it("has no confirmation hooks (nothing here needs a card)", () => {
    for (const tool of lowStakesWriteTools) {
      expect(tool.describeForConfirmation).toBeUndefined();
      expect(tool.validateBeforeConfirmation).toBeUndefined();
    }
  });

  it("touches only shortlist, system-health and Genosuke preference routes, never positions, orders or risk limits", async () => {
    const { api, post, patch, remove, put } = fakeApi();
    const inputs: Record<string, Record<string, unknown>> = {
      add_shortlist_ticker: { symbol: "AAPL" },
      trigger_ibkr_health_check: {},
      save_preference: { content: "c" },
      forget_preference: { id: "p1" },
    };
    for (const tool of lowStakesWriteTools) await tool.execute(inputs[tool.name]!, api);
    const paths = [...post.mock.calls, ...patch.mock.calls, ...remove.mock.calls].map((call) => String((call as unknown[])[0]));
    expect([...paths].sort()).toEqual(["/genosuke/preferences", "/genosuke/preferences/p1", "/shortlist", "/system-health/check-ibkr"]);
    expect(paths.every((path) => /^\/(shortlist|system-health|genosuke)/.test(path))).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("add_shortlist_ticker", () => {
  it("posts the symbol exactly as given and returns the response", async () => {
    const { api, post } = fakeApi();
    const input = { symbol: "AAPL" };
    expect(await toolNamed("add_shortlist_ticker").execute(input, api)).toEqual({ posted: true });
    expect(post).toHaveBeenCalledWith("/shortlist", input);
  });

  it("takes only the symbol", () => {
    const parameters = toolNamed("add_shortlist_ticker").parameters as { required: string[]; properties: Record<string, { type: string }> };
    expect(parameters.required).toEqual(["symbol"]);
    expect(Object.keys(parameters.properties)).toEqual(["symbol"]);
  });

  it("propagates the route's refusal", async () => {
    const { api, post } = fakeApi();
    post.mockRejectedValueOnce(new Error("POST /shortlist → 409: already on the shortlist"));
    await expect(toolNamed("add_shortlist_ticker").execute({ symbol: "AAPL" }, api)).rejects.toThrow("409");
  });
});

describe("trigger_ibkr_health_check", () => {
  it("posts an empty body to the health check route", async () => {
    const { api, post } = fakeApi();
    await toolNamed("trigger_ibkr_health_check").execute({}, api);
    expect(post).toHaveBeenCalledWith("/system-health/check-ibkr", {});
  });
});

describe("save_preference", () => {
  it("saves only the content text", async () => {
    const { api, post } = fakeApi();
    await toolNamed("save_preference").execute({ content: "ask before rolling short-dated puts", extra: 1 }, api);
    expect(post).toHaveBeenCalledWith("/genosuke/preferences", { content: "ask before rolling short-dated puts" });
  });
});

describe("forget_preference", () => {
  it("deletes the preference by id", async () => {
    const { api, remove } = fakeApi();
    await toolNamed("forget_preference").execute({ id: "pref-3" }, api);
    expect(remove).toHaveBeenCalledWith("/genosuke/preferences/pref-3");
  });
});

describe("ids in request paths", () => {
  it("are encoded for the preference route", async () => {
    const { api, remove } = fakeApi();
    await toolNamed("forget_preference").execute({ id: "../positions/x" }, api);
    await toolNamed("forget_preference").execute({ id: "p/1" }, api);
    expect((remove.mock.calls as unknown as string[][]).map((call) => call[0])).toEqual(["/genosuke/preferences/..%2Fpositions%2Fx", "/genosuke/preferences/p%2F1"]);
  });
});
