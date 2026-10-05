import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatTurn, OpenRouterAdapter } from "./openRouterAdapter.js";
import type { GenosukeApiClient } from "./apiClient.js";
import type { TelegramApi } from "./telegramApi.js";
import type { GenosukeTool } from "./tools/types.js";

// chatOnce's financial-write interception: the tools are fakes, the adapter replays scripted model turns.
const toolsByName = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./tools/index.js", () => ({ TOOLS_BY_NAME: toolsByName }));

const { chatOnce } = await import("./chat.js");
const { takeConfirmation } = await import("./confirmations.js");

const api = { get: vi.fn() } as unknown as GenosukeApiClient;
const sendMessage = vi.fn();
const telegram = { sendMessage } as unknown as TelegramApi;

type ToolResult = { id: string; content: string };

/** An adapter that returns the given turns in order and records what it was told about tool results. */
function scriptedAdapter(turns: Partial<ChatTurn>[]) {
  const toolResults: ToolResult[][] = [];
  let index = 0;
  const adapter = {
    call: vi.fn(async () => {
      const turn = turns[Math.min(index, turns.length - 1)]!;
      index += 1;
      return { textContent: "", toolCalls: [], isDone: false, usage: { inputTokens: 0, outputTokens: 0 }, ...turn } as ChatTurn;
    }),
    appendAssistantMessage: vi.fn(),
    appendToolResults: vi.fn((_messages: ChatMessage[], results: ToolResult[]) => {
      toolResults.push(results);
    }),
  };
  return { adapter: adapter as unknown as OpenRouterAdapter, toolResults };
}

const callTool = (name: string, input: Record<string, unknown>, id = "call-1") => ({ toolCalls: [{ id, name, input }] });
const finalText = { toolCalls: [], isDone: true, textContent: "done" };

function financialTool(overrides: Partial<GenosukeTool> & { name?: string } = {}): GenosukeTool & { execute: ReturnType<typeof vi.fn> } {
  const tool = { name: "create_position", description: "", parameters: { type: "object", properties: {} }, tier: "financial-write", execute: vi.fn(), ...overrides };
  toolsByName.set(tool.name, tool);
  return tool as GenosukeTool & { execute: ReturnType<typeof vi.fn> };
}

async function run(turns: Partial<ChatTurn>[]) {
  const { adapter, toolResults } = scriptedAdapter(turns);
  const messages: ChatMessage[] = [];
  const result = await chatOnce({ messages, userMessage: "hello", chatId: "chat-1", adapter, api, telegram });
  return { result, toolResults, adapter };
}

beforeEach(() => {
  toolsByName.clear();
  sendMessage.mockReset().mockResolvedValue(undefined);
  (api.get as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("chatOnce with a financial-write tool that prepares its confirmation", () => {
  it("sends NO card and returns the problem to the model as an error", async () => {
    const tool = financialTool({ prepareConfirmation: async () => ({ problem: "Blocked, nothing was placed: too big" }) });
    const { toolResults } = await run([callTool("create_position", { symbol: "AAOI" }), finalText]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toolResults).toEqual([[{ id: "call-1", content: "Error: Blocked, nothing was placed: too big" }]]);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("sends one card with Yes and Cancel buttons when it returns a description, and the confirmation carries `prepared`", async () => {
    const prepared = { orderId: "order-1" };
    const prepareConfirmation = vi.fn(async () => ({ description: "CARD TEXT", prepared }));
    const tool = financialTool({ prepareConfirmation });
    const input = { symbol: "AAOI", strategyKey: "cash_secured_put" };
    const { toolResults } = await run([callTool("create_position", input), finalText]);

    expect(prepareConfirmation).toHaveBeenCalledWith(input, api);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, options] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe("chat-1");
    expect(text).toBe("Confirm:\nCARD TEXT");
    const [[yesButton, cancelButton]] = options.buttons;
    expect(yesButton.text).toBe("Yes");
    expect(cancelButton.text).toBe("Cancel");
    const confirmationId = yesButton.callback_data.replace("confirm:", "");
    expect(cancelButton.callback_data).toBe(`cancel:${confirmationId}`);

    const confirmation = takeConfirmation(confirmationId);
    expect(confirmation).toMatchObject({ chatId: "chat-1", toolName: "create_position", input, description: "CARD TEXT" });
    expect(confirmation!.prepared).toBe(prepared);
    expect(tool.execute).not.toHaveBeenCalled(); // nothing executes inside the loop
    expect(toolResults[0]![0]!.content).toContain("Sent a Yes/Cancel confirmation");
  });

  it("treats a prepareConfirmation that throws as an error for the model, with no card", async () => {
    financialTool({
      prepareConfirmation: async () => {
        throw new Error("API unreachable");
      },
    });
    const { toolResults } = await run([callTool("create_position", {}), finalText]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toolResults).toEqual([[{ id: "call-1", content: "Error: API unreachable" }]]);
  });

  it("does not run validateBeforeConfirmation or describeForConfirmation for a tool that prepares", async () => {
    const validateBeforeConfirmation = vi.fn(async () => "should not be used");
    const describeForConfirmation = vi.fn(async () => "should not be used");
    financialTool({ prepareConfirmation: async () => ({ description: "CARD", prepared: { orderId: "o" } }), validateBeforeConfirmation, describeForConfirmation });
    await run([callTool("create_position", {}), finalText]);
    expect(validateBeforeConfirmation).not.toHaveBeenCalled();
    expect(describeForConfirmation).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0]![1]).toBe("Confirm:\nCARD");
  });

  it("two parallel financial-write calls each get their own card and their own prepared order", async () => {
    financialTool({ prepareConfirmation: async (input) => ({ description: `CARD ${input.symbol}`, prepared: { orderId: `order-${input.symbol}` } }) });
    await run([{ toolCalls: [{ id: "a", name: "create_position", input: { symbol: "AAA" } }, { id: "b", name: "create_position", input: { symbol: "BBB" } }] }, finalText]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const prepared = sendMessage.mock.calls.map((call) => takeConfirmation(call[2].buttons[0][0].callback_data.replace("confirm:", ""))!.prepared);
    expect(prepared).toEqual([{ orderId: "order-AAA" }, { orderId: "order-BBB" }]);
  });
});

describe("chatOnce with a financial-write tool that does not prepare", () => {
  it("returns a validateBeforeConfirmation problem to the model without a card", async () => {
    financialTool({ name: "update_risk_limits", validateBeforeConfirmation: async () => "Send at least one setting to change." });
    const { toolResults } = await run([callTool("update_risk_limits", {}), finalText]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toolResults).toEqual([[{ id: "call-1", content: "Error: Send at least one setting to change." }]]);
  });

  it("builds the card from describeForConfirmation and stores a confirmation with no prepared state", async () => {
    financialTool({ name: "update_risk_limits", describeForConfirmation: async () => "Update the trading limits\n• Min cash reserve %: 5 → 8" });
    await run([callTool("update_risk_limits", { minCashReservePct: 8 }), finalText]);
    expect(sendMessage.mock.calls[0]![1]).toBe("Confirm:\nUpdate the trading limits\n• Min cash reserve %: 5 → 8");
    const confirmation = takeConfirmation(sendMessage.mock.calls[0]![2].buttons[0][0].callback_data.replace("confirm:", ""));
    expect(confirmation!.prepared).toBeUndefined();
  });

  it("falls back to the raw input as the card when describeForConfirmation fails", async () => {
    financialTool({
      name: "update_risk_limits",
      describeForConfirmation: async () => {
        throw new Error("settings unreadable");
      },
    });
    await run([callTool("update_risk_limits", { minCashReservePct: 8 }), finalText]);
    expect(sendMessage.mock.calls[0]![1]).toBe('Confirm:\nupdate_risk_limits {"minCashReservePct":8}');
  });
});

describe("chatOnce with other tools", () => {
  it("reports an unknown tool to the model", async () => {
    const { toolResults } = await run([callTool("no_such_tool", {}), finalText]);
    expect(toolResults).toEqual([[{ id: "call-1", content: 'Error: unknown tool "no_such_tool".' }]]);
  });

  it("runs a read tool right away and gives the model its result", async () => {
    const execute = vi.fn(async () => ({ positions: 2 }));
    toolsByName.set("list_positions", { name: "list_positions", description: "", parameters: {}, tier: "read", execute });
    const { toolResults } = await run([callTool("list_positions", {}), finalText]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolResults).toEqual([[{ id: "call-1", content: '{"positions":2}' }]]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns the final text when the model is done", async () => {
    const { result } = await run([finalText]);
    expect(result).toEqual({ text: "done" });
  });
});
