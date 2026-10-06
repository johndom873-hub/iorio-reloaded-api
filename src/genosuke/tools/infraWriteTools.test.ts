import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenosukeApiClient } from "../apiClient.js";

const hoisted = vi.hoisted(() => ({
  addWafRule: vi.fn(),
  removeWafRule: vi.fn(),
  unblockIp: vi.fn(),
  startFreshGatewayLoginOnVps: vi.fn(),
  tradingMode: { current: "paper" },
}));

vi.mock("../../lib/cloudflareService.js", () => ({
  addWafRule: (...args: unknown[]) => hoisted.addWafRule(...args),
  removeWafRule: (...args: unknown[]) => hoisted.removeWafRule(...args),
  unblockIp: (...args: unknown[]) => hoisted.unblockIp(...args),
}));
vi.mock("../../ibkr/startFreshGatewayLoginOnVps.js", () => ({ startFreshGatewayLoginOnVps: () => hoisted.startFreshGatewayLoginOnVps() }));
vi.mock("../../config/env.js", () => ({
  environment: {
    get ibkrTradingMode() {
      return hoisted.tradingMode.current;
    },
  },
}));

const { infraWriteTools } = await import("./infraWriteTools.js");

const api = { name: "unused-api" } as unknown as GenosukeApiClient;

function toolNamed(name: string) {
  const tool = infraWriteTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

beforeEach(() => {
  hoisted.addWafRule.mockReset().mockResolvedValue({ id: "rule-1" });
  hoisted.removeWafRule.mockReset().mockResolvedValue({ removed: "rule-1" });
  hoisted.unblockIp.mockReset().mockResolvedValue({ removed: true });
  hoisted.startFreshGatewayLoginOnVps.mockReset();
  hoisted.tradingMode.current = "paper";
});

describe("the infra-write tool set", () => {
  it("is exactly the four tools that touch Cloudflare or the Gateway, all in the confirmation tier", () => {
    expect(infraWriteTools.map((tool) => tool.name)).toEqual(["add_waf_rule", "remove_waf_rule", "unblock_ip", "resend_gateway_2fa"]);
    expect(infraWriteTools.every((tool) => tool.tier === "infra-write")).toBe(true);
  });

  it("gives every tool a confirmation card, so none can fall back to a bare tool name", () => {
    for (const tool of infraWriteTools) expect(typeof tool.describeForConfirmation).toBe("function");
  });

  it("declares the arguments each tool needs as required", () => {
    expect(toolNamed("add_waf_rule").parameters).toMatchObject({ required: ["expression", "description"] });
    expect(toolNamed("remove_waf_rule").parameters).toMatchObject({ required: ["ruleId"] });
    expect(toolNamed("unblock_ip").parameters).toMatchObject({ required: ["ip"] });
    expect(toolNamed("resend_gateway_2fa").parameters).toMatchObject({ required: [] });
  });

  it("limits add_waf_rule actions to the four Cloudflare challenge/block kinds", () => {
    const properties = (toolNamed("add_waf_rule").parameters as { properties: { action: { enum: string[] } } }).properties;
    expect(properties.action.enum).toEqual(["block", "challenge", "js_challenge", "managed_challenge"]);
  });

  it("describing a card runs nothing", async () => {
    await toolNamed("add_waf_rule").describeForConfirmation!({ expression: "(ip.src eq 1.2.3.4)", description: "d" }, api);
    await toolNamed("remove_waf_rule").describeForConfirmation!({ ruleId: "r1" }, api);
    await toolNamed("unblock_ip").describeForConfirmation!({ ip: "1.2.3.4" }, api);
    await toolNamed("resend_gateway_2fa").describeForConfirmation!({}, api);
    expect(hoisted.addWafRule).not.toHaveBeenCalled();
    expect(hoisted.removeWafRule).not.toHaveBeenCalled();
    expect(hoisted.unblockIp).not.toHaveBeenCalled();
    expect(hoisted.startFreshGatewayLoginOnVps).not.toHaveBeenCalled();
  });
});

describe("add_waf_rule", () => {
  const input = { expression: "(ip.src eq 8.208.53.58)", description: "block scanner 8.208.53.58", action: "managed_challenge" };

  it("states the exact expression, action and label on the card", () => {
    expect(toolNamed("add_waf_rule").describeForConfirmation!(input, api)).toBe(
      'Add Cloudflare WAF rule on ioriore.com: (ip.src eq 8.208.53.58) → managed_challenge ("block scanner 8.208.53.58")',
    );
  });

  it("shows 'block' on the card when no action is given, and passes no action so the service default applies", async () => {
    const withoutAction = { expression: "(ip.src eq 1.2.3.4)", description: "d" };
    expect(toolNamed("add_waf_rule").describeForConfirmation!(withoutAction, api)).toContain("→ block (");
    await toolNamed("add_waf_rule").execute(withoutAction, api);
    expect(hoisted.addWafRule).toHaveBeenCalledWith({ expression: "(ip.src eq 1.2.3.4)", description: "d", action: undefined });
  });

  it("executes with exactly the arguments the card showed, and returns the service result", async () => {
    const result = await toolNamed("add_waf_rule").execute(input, api);
    expect(hoisted.addWafRule).toHaveBeenCalledTimes(1);
    expect(hoisted.addWafRule).toHaveBeenCalledWith({ expression: "(ip.src eq 8.208.53.58)", description: "block scanner 8.208.53.58", action: "managed_challenge" });
    expect(result).toEqual({ id: "rule-1" });
  });

  it("keeps a path expression with quotes intact", async () => {
    const pathInput = { expression: '(http.request.uri.path contains "/wp-login.php")', description: "wp scanner" };
    expect(toolNamed("add_waf_rule").describeForConfirmation!(pathInput, api)).toContain('(http.request.uri.path contains "/wp-login.php")');
    await toolNamed("add_waf_rule").execute(pathInput, api);
    expect(hoisted.addWafRule.mock.calls[0]![0].expression).toBe('(http.request.uri.path contains "/wp-login.php")');
  });

  it("propagates a Cloudflare failure to the caller", async () => {
    hoisted.addWafRule.mockRejectedValue(new Error("Cloudflare API 400: invalid expression"));
    await expect(toolNamed("add_waf_rule").execute(input, api)).rejects.toThrow("Cloudflare API 400: invalid expression");
  });
});

describe("remove_waf_rule", () => {
  it("names the rule id on the card and removes exactly that id", async () => {
    expect(toolNamed("remove_waf_rule").describeForConfirmation!({ ruleId: "abc123" }, api)).toBe("Remove Cloudflare WAF rule abc123 on ioriore.com");
    await toolNamed("remove_waf_rule").execute({ ruleId: "abc123" }, api);
    expect(hoisted.removeWafRule).toHaveBeenCalledWith("abc123");
  });

  it("coerces a numeric id to a string for the service", async () => {
    await toolNamed("remove_waf_rule").execute({ ruleId: 42 }, api);
    expect(hoisted.removeWafRule).toHaveBeenCalledWith("42");
  });

  it("propagates a failure", async () => {
    hoisted.removeWafRule.mockRejectedValue(new Error("not found"));
    await expect(toolNamed("remove_waf_rule").execute({ ruleId: "x" }, api)).rejects.toThrow("not found");
  });
});

describe("unblock_ip", () => {
  it("names the IP on the card and unblocks exactly that IP, returning the service result", async () => {
    hoisted.unblockIp.mockResolvedValue({ removed: true, ip: "1.2.3.4", remainingIps: ["5.6.7.8"] });
    expect(toolNamed("unblock_ip").describeForConfirmation!({ ip: "1.2.3.4" }, api)).toBe("Unblock IP 1.2.3.4 on ioriore.com's Cloudflare WAF");
    const result = await toolNamed("unblock_ip").execute({ ip: "1.2.3.4" }, api);
    expect(hoisted.unblockIp).toHaveBeenCalledWith("1.2.3.4");
    expect(result).toEqual({ removed: true, ip: "1.2.3.4", remainingIps: ["5.6.7.8"] });
  });
});

describe("resend_gateway_2fa", () => {
  const tool = () => toolNamed("resend_gateway_2fa");

  it("names the Gateway mode in upper case on the card", () => {
    expect(tool().describeForConfirmation!({}, api)).toBe("Restart the PAPER IBKR Gateway to send you a fresh 2FA push (you will have about 3 minutes to approve it)");
    hoisted.tradingMode.current = "live";
    expect(tool().describeForConfirmation!({}, api)).toContain("Restart the LIVE IBKR Gateway");
  });

  it("returns the script's result kind with its plain-language message", async () => {
    hoisted.startFreshGatewayLoginOnVps.mockResolvedValue({ resultKind: "waiting_for_2fa", output: "GATEWAY_CONTROL_RESULT=waiting_for_2fa" });
    const result = await tool().execute({}, api);
    expect(result).toEqual({
      result: "waiting_for_2fa",
      message: "Fresh login started. IBKR has sent a new 2FA push: you have about 3 minutes to approve it on your phone.",
    });
    expect(tool().describeResult!(result)).toBe((result as { message: string }).message);
  });

  it("passes a refusal through as an outcome, not an error", async () => {
    hoisted.startFreshGatewayLoginOnVps.mockResolvedValue({ resultKind: "refused_api_already_answering", output: "" });
    const result = (await tool().execute({}, api)) as { result: string; message: string };
    expect(result.result).toBe("refused_api_already_answering");
    expect(result.message).toMatch(/^Nothing was restarted/);
  });

  it("explains an unexpected result kind", async () => {
    hoisted.startFreshGatewayLoginOnVps.mockResolvedValue({ resultKind: "mystery", output: "" });
    expect(((await tool().execute({}, api)) as { message: string }).message).toBe("The VPS script returned an unexpected result: mystery.");
  });

  it("throws, quoting the end of the output, when the script printed no result", async () => {
    hoisted.startFreshGatewayLoginOnVps.mockResolvedValue({ resultKind: null, output: `${"noise ".repeat(100)}ssh: connection refused\n` });
    const error = await tool().execute({}, api).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.startsWith("The Gateway login script returned no result: ")).toBe(true);
    expect(message.endsWith("ssh: connection refused")).toBe(true);
    expect(message.length).toBe("The Gateway login script returned no result: ".length + 300);
  });

  it("propagates an SSH failure", async () => {
    hoisted.startFreshGatewayLoginOnVps.mockRejectedValue(new Error("Timed out waiting for the Gateway login script on the VPS."));
    await expect(tool().execute({}, api)).rejects.toThrow("Timed out");
  });
});

describe("refusing a request the card could not describe", () => {
  const problemFor = (name: string, input: Record<string, unknown>) => toolNamed(name).validateBeforeConfirmation!(input, api);

  it("add_waf_rule needs a non-empty expression and description", async () => {
    expect(await problemFor("add_waf_rule", { expression: "(ip.src eq 1.2.3.4)", description: "scanner" })).toBeNull();
    expect(await problemFor("add_waf_rule", { description: "scanner" })).toBe("expression must be a non-empty string.");
    expect(await problemFor("add_waf_rule", { expression: "  ", description: "" })).toBe("expression and description must be a non-empty string.");
    expect(await problemFor("add_waf_rule", { expression: 42, description: "x" })).toBe("expression must be a non-empty string.");
  });

  it("add_waf_rule accepts only the four Cloudflare actions, or none", async () => {
    for (const action of ["block", "challenge", "js_challenge", "managed_challenge", undefined]) {
      expect(await problemFor("add_waf_rule", { expression: "e", description: "d", action }), String(action)).toBeNull();
    }
    expect(await problemFor("add_waf_rule", { expression: "e", description: "d", action: "" })).toBe("action must be one of block, challenge, js_challenge, managed_challenge.");
    expect(await problemFor("add_waf_rule", { expression: "e", description: "d", action: "allow" })).toBe("action must be one of block, challenge, js_challenge, managed_challenge.");
  });

  it("remove_waf_rule needs a rule id and unblock_ip needs an address", async () => {
    expect(await problemFor("remove_waf_rule", { ruleId: "abc123" })).toBeNull();
    expect(await problemFor("remove_waf_rule", {})).toBe("ruleId must be a non-empty string.");
    expect(await problemFor("unblock_ip", { ip: "1.2.3.4" })).toBeNull();
    expect(await problemFor("unblock_ip", { ip: " " })).toBe("ip must be a non-empty string.");
  });
});
