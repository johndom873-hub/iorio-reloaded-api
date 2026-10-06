import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenosukeApiClient } from "../apiClient.js";

const hoisted = vi.hoisted(() => ({ listWafRules: vi.fn(), fetchLogsFromBetterStack: vi.fn() }));
vi.mock("../../lib/cloudflareService.js", () => ({ listWafRules: (...args: unknown[]) => hoisted.listWafRules(...args) }));
vi.mock("../../lib/betterstackService.js", () => ({ fetchLogsFromBetterStack: (...args: unknown[]) => hoisted.fetchLogsFromBetterStack(...args) }));

const { readTools } = await import("./readTools.js");

type Responder = (path: string) => unknown;

/** A GET-only API client that records every requested path and answers from `respond`. */
function fakeApi(respond: Responder = () => ({})) {
  const paths: string[] = [];
  const get = vi.fn(async (path: string) => {
    paths.push(path);
    const answer = respond(path);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const post = vi.fn();
  const put = vi.fn();
  const patch = vi.fn();
  const remove = vi.fn();
  return { api: { get, post, put, patch, delete: remove } as unknown as GenosukeApiClient, paths, writes: [post, put, patch, remove] };
}

function toolNamed(name: string) {
  const tool = readTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

beforeEach(() => {
  hoisted.listWafRules.mockReset().mockResolvedValue([]);
  hoisted.fetchLogsFromBetterStack.mockReset().mockResolvedValue("log lines");
});

describe("the read tool set", () => {
  it("is entirely in the read tier, with unique names", () => {
    expect(readTools.every((tool) => tool.tier === "read")).toBe(true);
    expect(new Set(readTools.map((tool) => tool.name)).size).toBe(readTools.length);
  });

  it("has no confirmation hooks, since nothing here may need a card", () => {
    for (const tool of readTools) {
      expect(tool.describeForConfirmation).toBeUndefined();
      expect(tool.prepareConfirmation).toBeUndefined();
    }
  });

  it("never writes through the API client", async () => {
    const { api, writes } = fakeApi((path) => (path.startsWith("/positions/p1") ? { legs: [] } : []));
    const inputs: Record<string, Record<string, unknown>> = {
      list_positions: { status: "open" },
      get_position: { positionId: "p1" },
      get_position_live_pnl_and_greeks: { positionId: "p1" },
      get_ticker_quote: { symbol: "aapl" },
      list_shortlist: { strategyKey: "covered_call" },
      search_tickers: { query: "apple" },
    };
    for (const tool of readTools) await tool.execute(inputs[tool.name] ?? {}, api).catch(() => {});
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });
});

describe("simple GET tools", () => {
  it.each([
    ["get_dashboard_summary", {}, "/dashboard/summary"],
    ["get_risk_limits_settings", {}, "/risk-limits/settings"],
    ["get_risk_exposure", {}, "/risk-limits/exposure"],
    ["get_system_health_status", {}, "/system-health/status"],
    ["list_shortlist", { strategyKey: "cash_secured_put" }, "/shortlist?strategy=cash_secured_put"],
  ])("%s requests %s", async (name, input, expectedPath) => {
    const { api, paths } = fakeApi(() => ({ ok: true }));
    expect(await toolNamed(name).execute(input, api)).toEqual({ ok: true });
    expect(paths).toEqual([expectedPath]);
  });
});

describe("get_pnl_history", () => {
  it("asks for the default window when days is omitted", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("get_pnl_history").execute({}, api);
    expect(paths).toEqual(["/dashboard/history"]);
  });

  it("passes days through", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("get_pnl_history").execute({ days: 30 }, api);
    expect(paths).toEqual(["/dashboard/history?days=30"]);
  });

  it("treats days of 0 as not given", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("get_pnl_history").execute({ days: 0 }, api);
    expect(paths).toEqual(["/dashboard/history"]);
  });
});

describe("list_positions", () => {
  it("requests the status and marks each leg open or closed", async () => {
    const { api, paths } = fakeApi(() => [{ id: "p1", legs: [{ id: "l1", exitAt: null }, { id: "l2", exitAt: "2026-09-01T00:00:00Z" }] }]);
    const result = await toolNamed("list_positions").execute({ status: "open" }, api);
    expect(paths).toEqual(["/positions?status=open"]);
    expect(result).toEqual([{ id: "p1", legs: [{ id: "l1", exitAt: null, isOpen: true }, { id: "l2", exitAt: "2026-09-01T00:00:00Z", isOpen: false }] }]);
  });

  it("requires a status and offers no strategy filter", () => {
    const parameters = toolNamed("list_positions").parameters as { properties: Record<string, unknown>; required: string[] };
    expect(parameters.required).toEqual(["status"]);
    expect(Object.keys(parameters.properties)).toEqual(["status"]);
  });
});

describe("get_position", () => {
  it("returns the position with its legs marked open or closed", async () => {
    const { api, paths } = fakeApi(() => ({ id: "p1", legs: [{ id: "l1", exitAt: null }] }));
    expect(await toolNamed("get_position").execute({ positionId: "p1" }, api)).toEqual({ id: "p1", legs: [{ id: "l1", exitAt: null, isOpen: true }] });
    expect(paths).toEqual(["/positions/p1"]);
  });

  it("points the model at list_positions when the lookup fails, keeping the original message", async () => {
    const { api } = fakeApi(() => new Error("GET /positions/stale → 404: not found"));
    await expect(toolNamed("get_position").execute({ positionId: "stale" }, api)).rejects.toThrow(
      "GET /positions/stale → 404: not found — the id may be stale or wrong; call list_positions for current position ids and retry with the right one.",
    );
  });

  it("handles a non-Error rejection", async () => {
    const api = { get: vi.fn().mockRejectedValue("offline") } as unknown as GenosukeApiClient;
    await expect(toolNamed("get_position").execute({ positionId: "p" }, api)).rejects.toThrow(/^offline — the id may be stale/);
  });
});

describe("get_position_live_pnl_and_greeks", () => {
  const position = {
    legs: [
      { id: "stock-1", legType: "stock", exitAt: null },
      { id: "call-open", legType: "option", exitAt: null },
      { id: "put-open", legType: "option", exitAt: null },
      { id: "call-closed", legType: "option", exitAt: "2026-09-01T00:00:00Z" },
    ],
  };

  it("fetches greeks for the open option legs only, plus the position's P&L, and picks this position's P&L out", async () => {
    const { api, paths } = fakeApi((path) => {
      if (path === "/positions/p1") return position;
      if (path.startsWith("/positions/greeks")) return { "call-open": { delta: 0.3 }, "put-open": { delta: -0.2 } };
      if (path.startsWith("/positions/pnl")) return { p1: 123.45, other: 1 };
      return {};
    });
    const result = await toolNamed("get_position_live_pnl_and_greeks").execute({ positionId: "p1" }, api);
    expect(result).toEqual({ greeksByLegId: { "call-open": { delta: 0.3 }, "put-open": { delta: -0.2 } }, unrealizedPnl: 123.45 });
    expect(paths).toContain("/positions/greeks?legIds=call-open,put-open");
    expect(paths).toContain("/positions/pnl?positionIds=p1");
  });

  it("skips the greeks request when there is no open option leg", async () => {
    const { api, paths } = fakeApi((path) => {
      if (path === "/positions/p2") return { legs: [{ id: "stock-1", legType: "stock", exitAt: null }, { id: "call-closed", legType: "option", exitAt: "2026-09-01T00:00:00Z" }] };
      if (path.startsWith("/positions/pnl")) return { p2: -5 };
      return {};
    });
    const result = await toolNamed("get_position_live_pnl_and_greeks").execute({ positionId: "p2" }, api);
    expect(result).toEqual({ greeksByLegId: {}, unrealizedPnl: -5 });
    expect(paths.some((path) => path.startsWith("/positions/greeks"))).toBe(false);
  });

  it("reports an undefined P&L when the server has none for the position", async () => {
    const { api } = fakeApi((path) => (path === "/positions/p3" ? { legs: [] } : {}));
    expect(((await toolNamed("get_position_live_pnl_and_greeks").execute({ positionId: "p3" }, api)) as { unrealizedPnl: unknown }).unrealizedPnl).toBeUndefined();
  });

  it("fails when the position cannot be read", async () => {
    const { api } = fakeApi(() => new Error("404"));
    await expect(toolNamed("get_position_live_pnl_and_greeks").execute({ positionId: "gone" }, api)).rejects.toThrow("404");
  });
});

describe("get_ticker_quote", () => {
  it("upper-cases the symbol", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("get_ticker_quote").execute({ symbol: "aaoi" }, api);
    expect(paths).toEqual(["/tickers/AAOI/quote"]);
  });
});

describe("list_trades", () => {
  it("asks for the whole blotter with no filters", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("list_trades").execute({}, api);
    expect(paths).toEqual(["/trade-blotter"]);
  });

  it("maps strategyKey to the strategy query parameter and passes the other filters", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("list_trades").execute({ strategyKey: "hedge", symbol: "TLT", from: "2026-09-01", to: "2026-09-30" }, api);
    expect(paths).toEqual(["/trade-blotter?strategy=hedge&symbol=TLT&from=2026-09-01&to=2026-09-30"]);
  });

  it("includes only the filters that were given", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("list_trades").execute({ symbol: "AAPL" }, api);
    expect(paths).toEqual(["/trade-blotter?symbol=AAPL"]);
  });

  it("encodes filter values", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("list_trades").execute({ symbol: "A&B=C" }, api);
    expect(paths).toEqual(["/trade-blotter?symbol=A%26B%3DC"]);
  });

  it("accepts the hedge and unstructured strategies the shortlist does not", () => {
    const properties = (toolNamed("list_trades").parameters as { properties: { strategyKey: { enum: string[] } } }).properties;
    expect(properties.strategyKey.enum).toEqual(["covered_call", "cash_secured_put", "hedge", "unstructured"]);
  });
});

describe("search_tickers", () => {
  it("URL-encodes the query", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("search_tickers").execute({ query: "berkshire hathaway & co" }, api);
    expect(paths).toEqual(["/shortlist/search?q=berkshire%20hathaway%20%26%20co"]);
  });
});

describe("get_gateway_readiness", () => {
  it("runs the open-stage check only when asked for stage 'open'", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("get_gateway_readiness").execute({ stage: "open" }, api);
    expect(paths).toEqual(["/system-health/readiness?stage=open"]);
  });

  it.each([[undefined], ["pre_open"], ["bogus"], ["OPEN"]])("falls back to pre_open for stage %s", async (stage) => {
    const { api, paths } = fakeApi();
    await toolNamed("get_gateway_readiness").execute({ stage }, api);
    expect(paths).toEqual(["/system-health/readiness?stage=pre_open"]);
  });
});

describe("list_job_runs", () => {
  it("uses the default window without a limit and passes a limit when given", async () => {
    const { api, paths } = fakeApi();
    await toolNamed("list_job_runs").execute({}, api);
    await toolNamed("list_job_runs").execute({ limit: 25 }, api);
    expect(paths).toEqual(["/system-health/jobs", "/system-health/jobs?limit=25"]);
  });
});

describe("list_waf_rules", () => {
  it("returns Cloudflare's rule list without touching the app API", async () => {
    hoisted.listWafRules.mockResolvedValue([{ id: "r1", description: "d", expression: "e", action: "block", enabled: true }]);
    const { api, paths } = fakeApi();
    expect(await toolNamed("list_waf_rules").execute({}, api)).toEqual([{ id: "r1", description: "d", expression: "e", action: "block", enabled: true }]);
    expect(paths).toEqual([]);
  });

  it("propagates a Cloudflare failure", async () => {
    hoisted.listWafRules.mockRejectedValue(new Error("Cloudflare API 403"));
    await expect(toolNamed("list_waf_rules").execute({}, fakeApi().api)).rejects.toThrow("Cloudflare API 403");
  });
});

describe("fetch_logs", () => {
  it("forwards the app, window and times to Better Stack and returns the text", async () => {
    const result = await toolNamed("fetch_logs").execute({ sourceApp: "api", minutes: 45, startTime: "2026-10-01T00:00:00Z", endTime: "2026-10-01T01:00:00Z" }, fakeApi().api);
    expect(result).toBe("log lines");
    expect(hoisted.fetchLogsFromBetterStack).toHaveBeenCalledWith({ sourceApp: "api", minutes: 45, startTime: "2026-10-01T00:00:00Z", endTime: "2026-10-01T01:00:00Z" });
  });

  it("leaves unspecified window fields undefined so the service applies its own default", async () => {
    await toolNamed("fetch_logs").execute({ sourceApp: "app" }, fakeApi().api);
    expect(hoisted.fetchLogsFromBetterStack).toHaveBeenCalledWith({ sourceApp: "app", minutes: undefined, startTime: undefined, endTime: undefined });
  });

  it("propagates a log service failure", async () => {
    hoisted.fetchLogsFromBetterStack.mockRejectedValue(new Error("Better Stack query failed"));
    await expect(toolNamed("fetch_logs").execute({ sourceApp: "api" }, fakeApi().api)).rejects.toThrow("Better Stack query failed");
  });
});

describe("ids and values in request paths", () => {
  it("are encoded, so a model-supplied id cannot climb out of its route", async () => {
    const { api, paths } = fakeApi(() => ({ legs: [] }));
    await toolNamed("get_position").execute({ positionId: "../risk-limits/settings" }, api);
    await toolNamed("get_ticker_quote").execute({ symbol: "a/b?x=1" }, api);
    await toolNamed("list_positions").execute({ status: "open&status=all" }, api);
    expect(paths).toEqual(["/positions/..%2Frisk-limits%2Fsettings", "/tickers/A%2FB%3FX%3D1/quote", "/positions?status=open%26status%3Dall"]);
  });

  it("leave an ordinary id, symbol and status unchanged", async () => {
    const { api, paths } = fakeApi(() => ({ legs: [] }));
    await toolNamed("get_position").execute({ positionId: "3f2b8c1e-aaaa-bbbb-cccc-123456789abc" }, api);
    await toolNamed("get_ticker_quote").execute({ symbol: "aapl" }, api);
    expect(paths).toEqual(["/positions/3f2b8c1e-aaaa-bbbb-cccc-123456789abc", "/tickers/AAPL/quote"]);
  });
});
