import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatTurn, OpenRouterAdapter } from "./openRouterAdapter.js";
import type { GenosukeApiClient } from "./apiClient.js";
import type { TelegramApi } from "./telegramApi.js";

// The real tool registry and the real chatOnce loop: a model asking for an infrastructure change must end in a
// Yes/Cancel card and nothing else, and only the stored confirmation may later run the tool.
const hoisted = vi.hoisted(() => ({
  addWafRule: vi.fn(),
  removeWafRule: vi.fn(),
  unblockIp: vi.fn(),
  listWafRules: vi.fn(),
  startFreshGatewayLoginOnVps: vi.fn(),
}));

vi.mock("../lib/cloudflareService.js", () => ({
  addWafRule: (...args: unknown[]) => hoisted.addWafRule(...args),
  removeWafRule: (...args: unknown[]) => hoisted.removeWafRule(...args),
  unblockIp: (...args: unknown[]) => hoisted.unblockIp(...args),
  listWafRules: (...args: unknown[]) => hoisted.listWafRules(...args),
}));
vi.mock("../ibkr/startFreshGatewayLoginOnVps.js", () => ({ startFreshGatewayLoginOnVps: () => hoisted.startFreshGatewayLoginOnVps() }));
vi.mock("../lib/betterstackService.js", () => ({ fetchLogsFromBetterStack: vi.fn() }));

const { chatOnce } = await import("./chat.js");
const { ALL_TOOLS, TOOLS_BY_NAME } = await import("./tools/index.js");
const { takeConfirmation } = await import("./confirmations.js");

const api = { get: vi.fn(async () => []) } as unknown as GenosukeApiClient;
const sendMessage = vi.fn();
const telegram = { sendMessage } as unknown as TelegramApi;

function scriptedAdapter(turns: Partial<ChatTurn>[]) {
  let index = 0;
  const adapter = {
    call: vi.fn(async () => ({ textContent: "", toolCalls: [], isDone: false, usage: { inputTokens: 0, outputTokens: 0 }, ...turns[Math.min(index++, turns.length - 1)] }) as ChatTurn),
    appendAssistantMessage: vi.fn(),
    appendToolResults: vi.fn(),
  };
  return adapter as unknown as OpenRouterAdapter;
}

async function askModelToCall(name: string, input: Record<string, unknown>) {
  const adapter = scriptedAdapter([{ toolCalls: [{ id: "call-1", name, input }] }, { toolCalls: [], isDone: true, textContent: "done" }]);
  const messages: ChatMessage[] = [];
  await chatOnce({ messages, userMessage: "do it", chatId: "chat-1", adapter, api, telegram });
  return { adapter };
}

const allInfraServiceMocks = () => [hoisted.addWafRule, hoisted.removeWafRule, hoisted.unblockIp, hoisted.startFreshGatewayLoginOnVps];

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(undefined);
  for (const mock of [...allInfraServiceMocks(), hoisted.listWafRules]) mock.mockReset().mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const infraCases: Array<{ tool: string; input: Record<string, unknown>; card: string; service: () => ReturnType<typeof vi.fn>; expectedArguments: unknown[] }> = [
  {
    tool: "add_waf_rule",
    input: { expression: "(ip.src eq 8.208.53.58)", description: "scanner" },
    card: 'Add Cloudflare WAF rule on ioriore.com: (ip.src eq 8.208.53.58) → block ("scanner")',
    service: () => hoisted.addWafRule,
    expectedArguments: [{ expression: "(ip.src eq 8.208.53.58)", description: "scanner", action: undefined }],
  },
  { tool: "remove_waf_rule", input: { ruleId: "r-9" }, card: "Remove Cloudflare WAF rule r-9 on ioriore.com", service: () => hoisted.removeWafRule, expectedArguments: ["r-9"] },
  { tool: "unblock_ip", input: { ip: "8.208.53.58" }, card: "Unblock IP 8.208.53.58 on ioriore.com's Cloudflare WAF", service: () => hoisted.unblockIp, expectedArguments: ["8.208.53.58"] },
];

describe.each(infraCases)("$tool through chatOnce", ({ tool, input, card, service, expectedArguments }) => {
  it("sends one Yes/Cancel card and executes nothing", async () => {
    await askModelToCall(tool, input);
    for (const mock of allInfraServiceMocks()) expect(mock).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toBe("chat-1");
    expect(sendMessage.mock.calls[0]![1]).toBe(`Confirm:\n${card}`);
    const [[yes, cancel]] = sendMessage.mock.calls[0]![2].buttons;
    expect([yes.text, cancel.text]).toEqual(["Yes", "Cancel"]);
  });

  it("tells the model a confirmation was sent, not that the action happened", async () => {
    const { adapter } = await askModelToCall(tool, input);
    const toolResults = (adapter.appendToolResults as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { content: string }[];
    expect(toolResults[0]!.content).toContain("Sent a Yes/Cancel confirmation");
    expect(toolResults[0]!.content).toContain("Do not call this tool again");
  });

  it("stores a confirmation for this chat that runs the service with the card's arguments only when executed", async () => {
    await askModelToCall(tool, input);
    const confirmationId = sendMessage.mock.calls[0]![2].buttons[0][0].callback_data.replace("confirm:", "");
    const confirmation = takeConfirmation(confirmationId)!;
    expect(confirmation).toMatchObject({ chatId: "chat-1", toolName: tool, input, description: card });
    expect(service()).not.toHaveBeenCalled();

    await TOOLS_BY_NAME.get(confirmation.toolName)!.execute(confirmation.input, api, confirmation.prepared);
    expect(service()).toHaveBeenCalledTimes(1);
    expect(service().mock.calls[0]).toEqual(expectedArguments);
  });

  it("cannot be confirmed twice", async () => {
    await askModelToCall(tool, input);
    const confirmationId = sendMessage.mock.calls[0]![2].buttons[0][0].callback_data.replace("confirm:", "");
    expect(takeConfirmation(confirmationId)).not.toBeNull();
    expect(takeConfirmation(confirmationId)).toBeNull();
  });
});

describe("resend_gateway_2fa through chatOnce", () => {
  it("sends a card and does not touch the Gateway", async () => {
    await askModelToCall("resend_gateway_2fa", {});
    expect(hoisted.startFreshGatewayLoginOnVps).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0]![1]).toMatch(/^Confirm:\nRestart the (PAPER|LIVE) IBKR Gateway to send you a fresh 2FA push/);
  });
});

describe("a read-tier call in the same registry", () => {
  it("list_waf_rules runs immediately with no card", async () => {
    hoisted.listWafRules.mockResolvedValue([{ id: "r1" }]);
    await askModelToCall("list_waf_rules", {});
    expect(hoisted.listWafRules).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("the registry", () => {
  it("has unique tool names", () => {
    expect(new Set(ALL_TOOLS.map((tool) => tool.name)).size).toBe(ALL_TOOLS.length);
  });

  it("puts every tool that can change Cloudflare or restart the Gateway behind a confirmation tier", () => {
    const infraNames = ["add_waf_rule", "remove_waf_rule", "unblock_ip", "resend_gateway_2fa"];
    for (const name of infraNames) expect(TOOLS_BY_NAME.get(name)!.tier).toBe("infra-write");
  });

  it("gives every confirmation-tier tool a way to build its card", () => {
    for (const tool of ALL_TOOLS.filter((candidate) => candidate.tier === "financial-write" || candidate.tier === "infra-write")) {
      expect(tool.prepareConfirmation !== undefined || tool.describeForConfirmation !== undefined, `${tool.name} has no card builder`).toBe(true);
    }
  });
});
