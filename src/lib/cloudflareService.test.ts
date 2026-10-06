import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeEnvironmentVariables: Record<string, string | undefined> = {};
vi.mock("../config/env.js", () => ({
  requireEnvironmentVariable: (variableName: string) => {
    const value = fakeEnvironmentVariables[variableName];
    if (!value) throw new Error(`Missing required environment variable: ${variableName}`);
    return value;
  },
}));

const { addWafRule, listWafRules, removeWafRule, unblockIp, updateWafRule } = await import("./cloudflareService.js");

const BASE_URL = "https://api.cloudflare.com/client/v4";
const ENTRYPOINT_URL = `${BASE_URL}/zones/zone-1/rulesets/phases/http_request_firewall_custom/entrypoint`;
const BLOCKLIST_DESCRIPTION = "blocked-ips (shared IP blocklist)";

interface FakeCloudflareReply {
  success?: boolean;
  result?: unknown;
  errors?: { code: number; message: string }[];
  httpStatus?: number;
}

let fetchMock: ReturnType<typeof vi.fn>;

function queueReplies(...replies: FakeCloudflareReply[]) {
  for (const reply of replies) {
    fetchMock.mockResolvedValueOnce({
      status: reply.httpStatus ?? 200,
      json: async () => ({ success: reply.success ?? true, result: reply.result, errors: reply.errors }),
    });
  }
}

function rule(id: string, overrides: Record<string, unknown> = {}) {
  return { id, description: `rule ${id}`, expression: `(http.host eq "${id}.example.com")`, action: "block", enabled: true, ...overrides };
}

function blocklistRule(id: string, expression: string) {
  return rule(id, { description: BLOCKLIST_DESCRIPTION, expression });
}

function noRulesetReply(): FakeCloudflareReply {
  return { success: false, errors: [{ code: 10003, message: "could not find entrypoint ruleset" }] };
}

function callAt(index: number) {
  const [url, init] = fetchMock.mock.calls[index]!;
  return { url: url as string, method: (init.method ?? "GET") as string, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers };
}

beforeEach(() => {
  fakeEnvironmentVariables.CLOUDFLARE_API_TOKEN = "test-token";
  fakeEnvironmentVariables.CLOUDFLARE_ZONE_ID = "zone-1";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloudflare request plumbing (via listWafRules)", () => {
  it("sends the bearer token, JSON content type and an abort signal to the zone entrypoint", async () => {
    queueReplies({ result: { id: "rs-1", rules: [] } });
    await listWafRules();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ENTRYPOINT_URL);
    expect(init.headers).toEqual({ Authorization: "Bearer test-token", "Content-Type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws before any request when the API token is missing", async () => {
    fakeEnvironmentVariables.CLOUDFLARE_API_TOKEN = undefined;
    await expect(listWafRules()).rejects.toThrow("Missing required environment variable: CLOUDFLARE_API_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws before any request when the zone id is missing", async () => {
    fakeEnvironmentVariables.CLOUDFLARE_ZONE_ID = undefined;
    await expect(listWafRules()).rejects.toThrow("Missing required environment variable: CLOUDFLARE_ZONE_ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws the first Cloudflare error message when success is false", async () => {
    queueReplies({ success: false, errors: [{ code: 9109, message: "Invalid access token" }, { code: 1, message: "second" }] });
    await expect(listWafRules()).rejects.toThrow("Invalid access token");
  });

  it("falls back to the HTTP status when a failure carries no error list", async () => {
    queueReplies({ success: false, httpStatus: 502 });
    await expect(listWafRules()).rejects.toThrow("Cloudflare API error (HTTP 502)");
  });

  it("propagates a non-JSON response body as a rejection", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(listWafRules()).rejects.toThrow("Unexpected token <");
  });

  it("propagates a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(listWafRules()).rejects.toThrow("socket hang up");
  });
});

describe("listWafRules", () => {
  it("returns only the summary fields of each rule", async () => {
    queueReplies({ result: { id: "rs-1", rules: [rule("a", { action_parameters: { response: {} }, extra: "x" }), rule("b", { enabled: false })] } });
    expect(await listWafRules()).toEqual([
      { id: "a", description: "rule a", expression: '(http.host eq "a.example.com")', action: "block", enabled: true },
      { id: "b", description: "rule b", expression: '(http.host eq "b.example.com")', action: "block", enabled: false },
    ]);
  });

  it("returns an empty list when the ruleset omits the rules field", async () => {
    queueReplies({ result: { id: "rs-1" } });
    expect(await listWafRules()).toEqual([]);
  });

  it("returns an empty list when the zone has no custom-rules ruleset yet (error code 10003)", async () => {
    queueReplies(noRulesetReply());
    expect(await listWafRules()).toEqual([]);
  });

  it("rethrows other Cloudflare errors", async () => {
    queueReplies({ success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    await expect(listWafRules()).rejects.toThrow("Authentication error");
  });
});

describe("addWafRule", () => {
  it("creates the ruleset with the shared blocklist rule when the zone has none and the expression is a single IP", async () => {
    queueReplies(noRulesetReply(), { result: { id: "rs-new", rules: [{ id: "new-rule", expression: "(ip.src eq 1.2.3.4)" }] } });
    const summary = await addWafRule({ expression: "(ip.src eq 1.2.3.4)", description: "attacker" });

    expect(callAt(1).url).toBe(ENTRYPOINT_URL);
    expect(callAt(1).method).toBe("PUT");
    expect(callAt(1).body).toEqual({ rules: [{ action: "block", expression: "(ip.src eq 1.2.3.4)", description: BLOCKLIST_DESCRIPTION }] });
    expect(summary).toEqual({ id: "new-rule", description: BLOCKLIST_DESCRIPTION, expression: "(ip.src eq 1.2.3.4)", action: "block", enabled: true });
  });

  it("appends a new shared blocklist rule to an existing ruleset that has none", async () => {
    queueReplies({ result: { id: "rs-1", rules: [rule("a")] } }, { result: { id: "rs-1", rules: [rule("a"), blocklistRule("b", "(ip.src eq 1.2.3.4)")] } });
    const summary = await addWafRule({ expression: "(ip.src eq 1.2.3.4)", description: "attacker" });

    expect(callAt(1).url).toBe(`${BASE_URL}/zones/zone-1/rulesets/rs-1/rules`);
    expect(callAt(1).method).toBe("POST");
    expect(callAt(1).body).toEqual({ action: "block", expression: "(ip.src eq 1.2.3.4)", description: BLOCKLIST_DESCRIPTION, enabled: true });
    expect(summary).toEqual({ id: "b", description: BLOCKLIST_DESCRIPTION, expression: "(ip.src eq 1.2.3.4)", action: "block", enabled: true });
  });

  it("merges a new IP into the existing blocklist rule by patching it with a multi-IP expression", async () => {
    const existing = blocklistRule("bl", "(ip.src eq 1.1.1.1)");
    queueReplies({ result: { id: "rs-1", rules: [existing] } }, { result: { id: "rs-1", rules: [existing] } }, { result: {} });
    const summary = await addWafRule({ expression: "(ip.src eq 2.2.2.2)", description: "ignored" });

    expect(callAt(2).url).toBe(`${BASE_URL}/zones/zone-1/rulesets/rs-1/rules/bl`);
    expect(callAt(2).method).toBe("PATCH");
    expect(callAt(2).body).toEqual({ action: "block", expression: "(ip.src in {1.1.1.1 2.2.2.2})", description: BLOCKLIST_DESCRIPTION, enabled: true });
    expect(summary).toEqual({ id: "bl", description: BLOCKLIST_DESCRIPTION, expression: "(ip.src in {1.1.1.1 2.2.2.2})", action: "block", enabled: true });
  });

  it("does not duplicate an IP that is already in the blocklist", async () => {
    const existing = blocklistRule("bl", "(ip.src in {1.1.1.1 2.2.2.2})");
    queueReplies({ result: { id: "rs-1", rules: [existing] } }, { result: { id: "rs-1", rules: [existing] } }, { result: {} });
    await addWafRule({ expression: "(ip.src in {2.2.2.2 3.3.3.3})", description: "x" });
    expect(callAt(2).body.expression).toBe("(ip.src in {1.1.1.1 2.2.2.2 3.3.3.3})");
  });

  it("supports IPv6 addresses in a single-IP expression", async () => {
    queueReplies(noRulesetReply(), { result: { id: "rs", rules: [{ id: "r", expression: "(ip.src eq 2001:db8::1)" }] } });
    await addWafRule({ expression: "(ip.src eq 2001:db8::1)", description: "v6" });
    expect(callAt(1).body.rules[0].expression).toBe("(ip.src eq 2001:db8::1)");
  });

  it("creates a standalone rule with its own description for a non-IP expression when the zone has no ruleset", async () => {
    queueReplies(noRulesetReply(), { result: { id: "rs-new", rules: [{ id: "geo-rule", expression: '(ip.geoip.country eq "XX")' }] } });
    const summary = await addWafRule({ expression: '(ip.geoip.country eq "XX")', description: "block XX", action: "managed_challenge" });

    expect(callAt(1).method).toBe("PUT");
    expect(callAt(1).body).toEqual({ rules: [{ action: "managed_challenge", expression: '(ip.geoip.country eq "XX")', description: "block XX" }] });
    expect(summary).toEqual({ id: "geo-rule", description: "block XX", expression: '(ip.geoip.country eq "XX")', action: "managed_challenge", enabled: true });
  });

  it("posts a standalone rule with action parameters to an existing ruleset", async () => {
    queueReplies({ result: { id: "rs-1", rules: [] } }, { result: { id: "rs-1", rules: [rule("older"), rule("created")] } });
    const summary = await addWafRule({
      expression: "(http.request.uri.path eq \"/x\")",
      description: "custom response",
      actionParameters: { response: { status_code: 403 } },
    });

    expect(callAt(1).url).toBe(`${BASE_URL}/zones/zone-1/rulesets/rs-1/rules`);
    expect(callAt(1).body).toEqual({
      action: "block",
      action_parameters: { response: { status_code: 403 } },
      expression: "(http.request.uri.path eq \"/x\")",
      description: "custom response",
      enabled: true,
    });
    expect(summary.id).toBe("created");
    expect(summary.description).toBe("custom response");
  });

  it("does not merge an IP-only block into the blocklist when action parameters are supplied", async () => {
    const existing = blocklistRule("bl", "(ip.src eq 1.1.1.1)");
    queueReplies({ result: { id: "rs-1", rules: [existing] } }, { result: { id: "rs-1", rules: [existing, rule("custom")] } });
    const summary = await addWafRule({ expression: "(ip.src eq 2.2.2.2)", description: "special", actionParameters: { response: { status_code: 429 } } });

    expect(callAt(1).method).toBe("POST");
    expect(callAt(1).body.description).toBe("special");
    expect(summary.id).toBe("custom");
  });

  it("does not merge an IP-only expression into the blocklist when the action is not block", async () => {
    const existing = blocklistRule("bl", "(ip.src eq 1.1.1.1)");
    queueReplies({ result: { id: "rs-1", rules: [existing] } }, { result: { id: "rs-1", rules: [existing, rule("challenge")] } });
    const summary = await addWafRule({ expression: "(ip.src eq 2.2.2.2)", description: "challenge it", action: "managed_challenge" });

    expect(callAt(1).method).toBe("POST");
    expect(callAt(1).body).toMatchObject({ action: "managed_challenge", expression: "(ip.src eq 2.2.2.2)", description: "challenge it" });
    expect(summary).toMatchObject({ id: "challenge", action: "managed_challenge" });
  });

  it("propagates a Cloudflare error from the create call", async () => {
    queueReplies({ result: { id: "rs-1", rules: [] } }, { success: false, errors: [{ code: 20217, message: "rule limit reached" }] });
    await expect(addWafRule({ expression: "(http.host eq \"x\")", description: "d" })).rejects.toThrow("rule limit reached");
  });
});

describe("unblockIp", () => {
  it("reports that no shared blocklist rule exists", async () => {
    queueReplies({ result: { id: "rs-1", rules: [rule("a")] } });
    expect(await unblockIp("1.1.1.1")).toEqual({ removed: false, reason: "No shared IP blocklist rule found." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports that no blocklist exists when the zone has no ruleset at all", async () => {
    queueReplies(noRulesetReply());
    expect(await unblockIp("1.1.1.1")).toEqual({ removed: false, reason: "No shared IP blocklist rule found." });
  });

  it("reports an IP that is not in the blocklist without writing", async () => {
    queueReplies({ result: { id: "rs-1", rules: [blocklistRule("bl", "(ip.src in {1.1.1.1 2.2.2.2})")] } });
    expect(await unblockIp("9.9.9.9")).toEqual({ removed: false, reason: "9.9.9.9 is not currently blocked." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deletes the whole rule when the last IP is removed", async () => {
    queueReplies({ result: { id: "rs-1", rules: [blocklistRule("bl", "(ip.src eq 1.1.1.1)")] } }, { result: {} });
    expect(await unblockIp("1.1.1.1")).toEqual({ removed: true, ip: "1.1.1.1", ruleDeleted: true });
    expect(callAt(1).url).toBe(`${BASE_URL}/zones/zone-1/rulesets/rs-1/rules/bl`);
    expect(callAt(1).method).toBe("DELETE");
  });

  it("patches the rule down to a single-IP expression when one IP remains", async () => {
    const existing = blocklistRule("bl", "(ip.src in {1.1.1.1 2.2.2.2})");
    queueReplies({ result: { id: "rs-1", rules: [existing] } }, { result: { id: "rs-1", rules: [existing] } }, { result: {} });
    expect(await unblockIp("1.1.1.1")).toEqual({ removed: true, ip: "1.1.1.1", remainingIps: ["2.2.2.2"] });
    expect(callAt(2).method).toBe("PATCH");
    expect(callAt(2).body.expression).toBe("(ip.src eq 2.2.2.2)");
  });

  it("keeps the remaining IPs in a multi-IP expression", async () => {
    const existing = blocklistRule("bl", "(ip.src in {1.1.1.1 2.2.2.2 3.3.3.3})");
    queueReplies({ result: { id: "rs-1", rules: [existing] } }, { result: { id: "rs-1", rules: [existing] } }, { result: {} });
    const outcome = await unblockIp("2.2.2.2");
    expect(outcome.remainingIps).toEqual(["1.1.1.1", "3.3.3.3"]);
    expect(callAt(2).body.expression).toBe("(ip.src in {1.1.1.1 3.3.3.3})");
  });

  it("treats an unparseable blocklist expression as empty, so no IP is blocked", async () => {
    queueReplies({ result: { id: "rs-1", rules: [blocklistRule("bl", "(ip.src in $my_list)")] } });
    expect(await unblockIp("1.1.1.1")).toEqual({ removed: false, reason: "1.1.1.1 is not currently blocked." });
  });
});

describe("updateWafRule", () => {
  const existing = rule("r1", { description: "old description", expression: "(http.host eq \"old\")", action: "block", action_parameters: { response: { status_code: 403 } } });

  it("merges only the supplied fields onto the current rule values", async () => {
    queueReplies({ result: { id: "rs-1", rules: [existing] } }, { result: {} });
    const summary = await updateWafRule("r1", { description: "new description" });

    expect(callAt(1).url).toBe(`${BASE_URL}/zones/zone-1/rulesets/rs-1/rules/r1`);
    expect(callAt(1).method).toBe("PATCH");
    expect(callAt(1).body).toEqual({
      action: "block",
      expression: "(http.host eq \"old\")",
      description: "new description",
      enabled: true,
      action_parameters: { response: { status_code: 403 } },
    });
    expect(summary).toEqual({ id: "r1", description: "new description", expression: "(http.host eq \"old\")", action: "block", enabled: true });
  });

  it("overrides expression, action and action parameters when supplied", async () => {
    queueReplies({ result: { id: "rs-1", rules: [existing] } }, { result: {} });
    const summary = await updateWafRule("r1", { expression: "(http.host eq \"new\")", action: "log", actionParameters: { x: 1 } });

    expect(callAt(1).body).toEqual({ action: "log", expression: "(http.host eq \"new\")", description: "old description", enabled: true, action_parameters: { x: 1 } });
    expect(summary).toMatchObject({ action: "log", expression: "(http.host eq \"new\")", description: "old description" });
  });

  it("omits action_parameters when neither the update nor the current rule has any", async () => {
    queueReplies({ result: { id: "rs-1", rules: [rule("r2")] } }, { result: {} });
    await updateWafRule("r2", { description: "d" });
    expect(callAt(1).body).not.toHaveProperty("action_parameters");
  });

  it("throws and does not patch when the rule id does not exist", async () => {
    queueReplies({ result: { id: "rs-1", rules: [existing] } });
    await expect(updateWafRule("missing", { description: "d" })).rejects.toThrow("No WAF rule found with id missing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the zone has no ruleset", async () => {
    queueReplies(noRulesetReply());
    await expect(updateWafRule("r1", { description: "d" })).rejects.toThrow("No WAF rule found with id r1");
  });

  it("keeps a disabled rule disabled: sends enabled false and reports it", async () => {
    queueReplies({ result: { id: "rs-1", rules: [rule("r3", { enabled: false })] } }, { result: {} });
    const summary = await updateWafRule("r3", { description: "edited" });
    expect(callAt(1).body.enabled).toBe(false);
    expect(summary.enabled).toBe(false);
  });

  it("treats a rule that reports no enabled flag as enabled", async () => {
    queueReplies({ result: { id: "rs-1", rules: [rule("r4", { enabled: undefined })] } }, { result: {} });
    const summary = await updateWafRule("r4", { description: "edited" });
    expect(callAt(1).body.enabled).toBe(true);
    expect(summary.enabled).toBe(true);
  });
});

describe("a disabled shared blocklist rule", () => {
  it("stays disabled when an IP is added to it or removed from it", async () => {
    const disabledBlocklist = { ...blocklistRule("bl", "(ip.src in {1.1.1.1 2.2.2.2})"), enabled: false };
    queueReplies({ result: { id: "rs-1", rules: [disabledBlocklist] } }, { result: { id: "rs-1", rules: [disabledBlocklist] } }, { result: {} });
    await addWafRule({ expression: "(ip.src eq 3.3.3.3)", description: "x" });
    expect(callAt(2).body.enabled).toBe(false);

    fetchMock.mockClear();
    queueReplies({ result: { id: "rs-1", rules: [disabledBlocklist] } }, { result: { id: "rs-1", rules: [disabledBlocklist] } }, { result: {} });
    await unblockIp("1.1.1.1");
    expect(callAt(2).body.enabled).toBe(false);
  });
});

describe("removeWafRule", () => {
  it("deletes the rule from the current ruleset and returns its id", async () => {
    queueReplies({ result: { id: "rs-1", rules: [rule("r1")] } }, { result: {} });
    expect(await removeWafRule("r1")).toEqual({ removed: "r1" });
    expect(callAt(1).url).toBe(`${BASE_URL}/zones/zone-1/rulesets/rs-1/rules/r1`);
    expect(callAt(1).method).toBe("DELETE");
  });

  it("propagates a Cloudflare error from the delete call", async () => {
    queueReplies({ result: { id: "rs-1", rules: [rule("r1")] } }, { success: false, errors: [{ code: 10001, message: "rule is locked" }] });
    await expect(removeWafRule("r1")).rejects.toThrow("rule is locked");
  });

  it("throws a clear error and sends no delete when the rule id does not exist", async () => {
    queueReplies({ result: { id: "rs-1", rules: [rule("r1")] } });
    await expect(removeWafRule("ghost")).rejects.toThrow("No WAF rule found with id ghost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws the same clear error, instead of deleting from a 'null' ruleset, when the zone has no ruleset", async () => {
    queueReplies(noRulesetReply());
    await expect(removeWafRule("r1")).rejects.toThrow("No WAF rule found with id r1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callAt(0).method).toBe("GET");
  });
});
