import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatTurn, OpenRouterAdapter } from "./openRouterAdapter.js";
import type { GenosukeApiClient } from "./apiClient.js";
import type { TelegramApi } from "./telegramApi.js";
import type { GenosukeTool } from "./tools/types.js";

// chatOnce's financial-write interception: the tools are fakes, the adapter replays scripted model turns.
const toolsByName = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./tools/index.js", () => ({ TOOLS_BY_NAME: toolsByName }));

const { chatOnce } = await import("./chat.js");
const { GenosukeApiError } = await import("./apiClient.js");
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

const readTool = (name: string, execute: GenosukeTool["execute"]) => toolsByName.set(name, { name, description: "", parameters: {}, tier: "read", execute });
const callsToAdapter = (adapter: OpenRouterAdapter) => (adapter.call as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as { systemText: string; messages: ChatMessage[]; tools: unknown[]; maxTokens: number });

describe("chatOnce with an infra-write tool", () => {
  function infraTool(overrides: Partial<GenosukeTool> = {}) {
    const tool = { name: "unblock_ip", description: "", parameters: {}, tier: "infra-write", execute: vi.fn(), ...overrides };
    toolsByName.set(tool.name, tool);
    return tool as GenosukeTool & { execute: ReturnType<typeof vi.fn> };
  }

  it("sends a Yes/Cancel card built by describeForConfirmation and never executes inside the loop", async () => {
    const tool = infraTool({ describeForConfirmation: (input) => `Unblock IP ${input.ip}` });
    const { toolResults } = await run([callTool("unblock_ip", { ip: "1.2.3.4" }), finalText]);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toBe("Confirm:\nUnblock IP 1.2.3.4");
    const confirmation = takeConfirmation(sendMessage.mock.calls[0]![2].buttons[0][0].callback_data.replace("confirm:", ""));
    expect(confirmation).toMatchObject({ chatId: "chat-1", toolName: "unblock_ip", input: { ip: "1.2.3.4" }, description: "Unblock IP 1.2.3.4" });
    expect(toolResults[0]![0]!.content).toContain("Sent a Yes/Cancel confirmation");
  });

  it("falls back to the bare tool name as the card when the tool has no describer", async () => {
    infraTool();
    await run([callTool("unblock_ip", { ip: "1.2.3.4" }), finalText]);
    expect(sendMessage.mock.calls[0]![1]).toBe("Confirm:\nunblock_ip");
  });

  it("still sends a card, built from the raw input, when the describer throws", async () => {
    infraTool({
      describeForConfirmation: () => {
        throw new Error("cannot describe");
      },
    });
    await run([callTool("unblock_ip", { ip: "1.2.3.4" }), finalText]);
    expect(sendMessage.mock.calls[0]![1]).toBe('Confirm:\nunblock_ip {"ip":"1.2.3.4"}');
  });

  it("returns a validateBeforeConfirmation problem to the model and sends no card", async () => {
    const tool = infraTool({ validateBeforeConfirmation: async () => "Not a valid IP." });
    const { toolResults } = await run([callTool("unblock_ip", { ip: "x" }), finalText]);
    expect(toolResults).toEqual([[{ id: "call-1", content: "Error: Not a valid IP." }]]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("still sends the card when the validator itself throws (the route validates again on Yes)", async () => {
    infraTool({
      describeForConfirmation: () => "CARD",
      validateBeforeConfirmation: async () => {
        throw new Error("lookup failed");
      },
    });
    await run([callTool("unblock_ip", {}), finalText]);
    expect(sendMessage.mock.calls[0]![1]).toBe("Confirm:\nCARD");
  });

  it("handles a read call and an infra call in the same turn: the read runs, the infra one only gets a card", async () => {
    const infra = infraTool({ describeForConfirmation: () => "CARD" });
    const execute = vi.fn(async () => ({ rules: [] }));
    readTool("list_waf_rules", execute);
    const { toolResults } = await run([{ toolCalls: [{ id: "a", name: "list_waf_rules", input: {} }, { id: "b", name: "unblock_ip", input: { ip: "1.1.1.1" } }] }, finalText]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(infra.execute).not.toHaveBeenCalled();
    expect(toolResults[0]!.map((result) => result.id)).toEqual(["a", "b"]);
    expect(toolResults[0]![0]!.content).toBe('{"rules":[]}');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("chatOnce read-tool failures", () => {
  it("gives the model the message of a failed tool as an error, and logs it", async () => {
    readTool("get_position", async () => {
      throw new Error("route exploded");
    });
    const { toolResults } = await run([callTool("get_position", {}), finalText]);
    expect(toolResults).toEqual([[{ id: "call-1", content: "Error: route exploded" }]]);
    expect(console.error).toHaveBeenCalledWith('Genosuke: tool "get_position" failed', "route exploded");
  });

  it("uses an API error's message", async () => {
    readTool("get_position", async () => {
      throw new GenosukeApiError(404, "GET /positions/x → 404: not found");
    });
    const { toolResults } = await run([callTool("get_position", {}), finalText]);
    expect(toolResults[0]![0]!.content).toBe("Error: GET /positions/x → 404: not found");
  });

  it("stringifies a non-Error rejection", async () => {
    readTool("get_position", async () => {
      throw "plain string";
    });
    const { toolResults } = await run([callTool("get_position", {}), finalText]);
    expect(toolResults[0]![0]!.content).toBe("Error: plain string");
  });

  it("one failing call does not stop the other calls of the same turn", async () => {
    readTool("bad", async () => {
      throw new Error("nope");
    });
    readTool("good", async () => "fine");
    const { toolResults } = await run([{ toolCalls: [{ id: "a", name: "bad", input: {} }, { id: "b", name: "good", input: {} }] }, finalText]);
    expect(toolResults[0]).toEqual([{ id: "a", content: "Error: nope" }, { id: "b", content: '"fine"' }]);
  });
});

describe("chatOnce tool result size", () => {
  it("passes a result that returns nothing as null", async () => {
    readTool("forget_preference", async () => undefined);
    const { toolResults } = await run([callTool("forget_preference", {}), finalText]);
    expect(toolResults[0]![0]!.content).toBe("null");
  });

  it("keeps a result of exactly 20000 characters whole", async () => {
    readTool("big", async () => "x".repeat(20_000 - 2));
    const { toolResults } = await run([callTool("big", {}), finalText]);
    expect(toolResults[0]![0]!.content).toHaveLength(20_000);
    expect(toolResults[0]![0]!.content).not.toContain("truncated");
  });

  it("truncates a longer result and says so", async () => {
    readTool("big", async () => "x".repeat(30_000));
    const { toolResults } = await run([callTool("big", {}), finalText]);
    const content = toolResults[0]![0]!.content;
    expect(content.endsWith("… [truncated: result exceeded context limit]")).toBe(true);
    expect(content.length).toBe(20_000 + "… [truncated: result exceeded context limit]".length);
  });
});

describe("chatOnce loop control", () => {
  it("adds the user's message to the conversation before the model is called", async () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: "earlier" }];
    const { adapter } = scriptedAdapter([finalText]);
    await chatOnce({ messages, userMessage: "new question", chatId: "chat-1", adapter, api, telegram });
    expect(messages.slice(0, 2)).toEqual([{ role: "assistant", content: "earlier" }, { role: "user", content: "new question" }]);
  });

  it("offers the model every registered tool and a 1024 token budget", async () => {
    readTool("one", async () => 1);
    readTool("two", async () => 2);
    const { adapter } = await run([finalText]);
    const [call] = callsToAdapter(adapter);
    expect(call!.tools).toHaveLength(2);
    expect(call!.maxTokens).toBe(1024);
  });

  it("returns the text when the model stops calling tools even if it did not mark the turn done", async () => {
    const { result } = await run([{ toolCalls: [], isDone: false, textContent: "just text" }]);
    expect(result).toEqual({ text: "just text" });
  });

  it("returns the text of a turn marked done without running the tool calls it still lists", async () => {
    const execute = vi.fn();
    readTool("get_position", execute);
    const { result } = await run([{ ...callTool("get_position", {}), isDone: true, textContent: "final" }]);
    expect(result).toEqual({ text: "final" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not store tool calls it will not run, so the chat history stays valid for the next model call", async () => {
    readTool("get_position", vi.fn());
    const { adapter } = await run([{ ...callTool("get_position", {}), isDone: true, textContent: "final" }]);
    const appended = (adapter.appendAssistantMessage as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(appended).toHaveLength(1);
    expect(appended[0]![1]).toMatchObject({ textContent: "final", toolCalls: [] });
  });

  it("still stores the tool calls of a turn whose tools it does run", async () => {
    readTool("get_position", async () => ({}));
    const { adapter } = await run([callTool("get_position", {}), finalText]);
    const firstStored = (adapter.appendAssistantMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(firstStored.toolCalls).toEqual([{ id: "call-1", name: "get_position", input: {} }]);
  });

  it("calls the model again after tool results, up to eight times, then throws", async () => {
    readTool("get_position", async () => ({}));
    const { adapter, toolResults } = scriptedAdapter([callTool("get_position", {})]);
    await expect(chatOnce({ messages: [], userMessage: "loop", chatId: "chat-1", adapter, api, telegram })).rejects.toThrow("Genosuke chat: max iterations reached without a final response.");
    expect((adapter.call as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(8);
    expect(toolResults).toHaveLength(8);
  });

  it("lets an error from the model call propagate", async () => {
    const adapter = { call: vi.fn().mockRejectedValue(new Error("OpenRouter API 500: boom")), appendAssistantMessage: vi.fn(), appendToolResults: vi.fn() } as unknown as OpenRouterAdapter;
    await expect(chatOnce({ messages: [], userMessage: "x", chatId: "chat-1", adapter, api, telegram })).rejects.toThrow("OpenRouter API 500: boom");
  });
});

describe("chatOnce system prompt", () => {
  it("appends the saved preferences with their ids", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "p1", content: "ask before rolling puts" }, { id: "p2", content: "no earnings week CSPs" }]);
    const { adapter } = await run([finalText]);
    const { systemText } = callsToAdapter(adapter)[0]!;
    expect(api.get).toHaveBeenCalledWith("/genosuke/preferences");
    expect(systemText).toContain("- [p1] ask before rolling puts\n- [p2] no earnings week CSPs");
    expect(systemText).toContain("You are Genosuke");
  });

  it("says there are none yet when no preference is saved", async () => {
    const { adapter } = await run([finalText]);
    expect(callsToAdapter(adapter)[0]!.systemText.endsWith("(none yet)")).toBe(true);
  });

  it("runs the turn on the core prompt alone when the preferences cannot be loaded", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API down"));
    const { adapter, result } = await run([finalText]);
    const { systemText } = callsToAdapter(adapter)[0]!;
    expect(systemText).toContain("You are Genosuke");
    expect(systemText).not.toContain("Preferences Marce and Juan");
    expect(result).toEqual({ text: "done" });
  });

  it("tells the model that confirmation-tier tools only send a card", async () => {
    const { adapter } = await run([finalText]);
    expect(callsToAdapter(adapter)[0]!.systemText).toContain("Calling one of those tools does NOT execute it");
  });
});

describe("chatOnce unknown tool alongside real ones", () => {
  it("answers each call by its own id", async () => {
    readTool("good", async () => "ok");
    const { toolResults } = await run([{ toolCalls: [{ id: "x", name: "ghost", input: {} }, { id: "y", name: "good", input: {} }] }, finalText]);
    expect(toolResults[0]).toEqual([{ id: "x", content: 'Error: unknown tool "ghost".' }, { id: "y", content: '"ok"' }]);
  });
});
