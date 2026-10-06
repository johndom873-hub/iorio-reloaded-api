import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordCallDuration = vi.hoisted(() => vi.fn());
vi.mock("./llmStats.js", () => ({ record: recordCallDuration }));

const { OpenRouterAdapter, parseChoice, toOpenAIMessages, toOpenAITools } = await import("./openRouterAdapter.js");
import type { ChatMessage, ChatTurn, ToolDefinition } from "./openRouterAdapter.js";

describe("toOpenAIMessages", () => {
  it("starts with the system prompt", () => {
    expect(toOpenAIMessages("SYSTEM", [])).toEqual([{ role: "system", content: "SYSTEM" }]);
  });

  it("maps user, plain assistant and tool messages in order", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "tool", content: '{"ok":true}', toolCallId: "call-1" },
    ];
    expect(toOpenAIMessages("S", messages)).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "tool", tool_call_id: "call-1", content: '{"ok":true}' },
    ]);
  });

  it("serialises an assistant tool call as an OpenAI function call with JSON string arguments", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: "checking", toolCalls: [{ id: "call-9", name: "unblock_ip", input: { ip: "1.2.3.4" } }] }];
    expect(toOpenAIMessages("S", messages)[1]).toEqual({
      role: "assistant",
      content: "checking",
      tool_calls: [{ id: "call-9", type: "function", function: { name: "unblock_ip", arguments: '{"ip":"1.2.3.4"}' } }],
    });
  });

  it("gives an assistant message that only calls tools the placeholder content some endpoints require", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: null, toolCalls: [{ id: "c", name: "t", input: {} }] }];
    expect(toOpenAIMessages("S", messages)[1]).toMatchObject({ content: "...", tool_calls: [{ function: { arguments: "{}" } }] });
  });

  it("uses an empty string, not the placeholder, for an assistant message with neither text nor tool calls", () => {
    expect(toOpenAIMessages("S", [{ role: "assistant", content: null }])[1]).toEqual({ role: "assistant", content: "" });
    expect(toOpenAIMessages("S", [{ role: "assistant", content: "", toolCalls: [] }])[1]).toEqual({ role: "assistant", content: "" });
  });

  it("emits several tool calls in their original order", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, toolCalls: [{ id: "a", name: "one", input: {} }, { id: "b", name: "two", input: { x: 1 } }] },
    ];
    const entry = toOpenAIMessages("S", messages)[1] as { tool_calls: { id: string }[] };
    expect(entry.tool_calls.map((call) => call.id)).toEqual(["a", "b"]);
  });
});

describe("toOpenAITools", () => {
  it("wraps each definition as a function tool", () => {
    const definitions: ToolDefinition[] = [{ name: "get_position", description: "Fetch one", parameters: { type: "object", properties: { positionId: { type: "string" } } } }];
    expect(toOpenAITools(definitions)).toEqual([
      { type: "function", function: { name: "get_position", description: "Fetch one", parameters: { type: "object", properties: { positionId: { type: "string" } } } } },
    ]);
  });

  it("returns an empty list for no tools", () => {
    expect(toOpenAITools([])).toEqual([]);
  });
});

describe("parseChoice", () => {
  it("parses text and marks 'stop' and 'end_turn' as done", () => {
    expect(parseChoice({ message: { content: "answer" }, finish_reason: "stop" })).toEqual({ textContent: "answer", toolCalls: [], isDone: true });
    expect(parseChoice({ message: { content: "answer" }, finish_reason: "end_turn" }).isDone).toBe(true);
  });

  it("is not done for tool_calls, length or any other finish reason", () => {
    for (const finishReason of ["tool_calls", "length", "content_filter", ""]) {
      expect(parseChoice({ message: { content: "x" }, finish_reason: finishReason }).isDone).toBe(false);
    }
  });

  it("turns null content into an empty string", () => {
    expect(parseChoice({ message: { content: null }, finish_reason: "stop" }).textContent).toBe("");
  });

  it("parses tool call arguments from their JSON string", () => {
    const parsed = parseChoice({
      message: { content: null, tool_calls: [{ id: "call-1", function: { name: "add_waf_rule", arguments: '{"expression":"(ip.src eq 1.2.3.4)","description":"d"}' } }] },
      finish_reason: "tool_calls",
    });
    expect(parsed.toolCalls).toEqual([{ id: "call-1", name: "add_waf_rule", input: { expression: "(ip.src eq 1.2.3.4)", description: "d" } }]);
  });

  it("treats empty arguments as an empty object", () => {
    const parsed = parseChoice({ message: { content: null, tool_calls: [{ id: "c", function: { name: "resend_gateway_2fa", arguments: "" } }] }, finish_reason: "tool_calls" });
    expect(parsed.toolCalls[0]!.input).toEqual({});
  });

  it("throws on malformed tool arguments instead of running the tool with guessed input", () => {
    expect(() => parseChoice({ message: { content: null, tool_calls: [{ id: "c", function: { name: "t", arguments: '{"ip": "1.2' } }] }, finish_reason: "tool_calls" })).toThrow(SyntaxError);
  });

  it("keeps several tool calls in order", () => {
    const parsed = parseChoice({
      message: { content: "", tool_calls: [{ id: "a", function: { name: "one", arguments: "{}" } }, { id: "b", function: { name: "two", arguments: '{"n":2}' } }] },
      finish_reason: "tool_calls",
    });
    expect(parsed.toolCalls.map((call) => [call.id, call.name, call.input])).toEqual([["a", "one", {}], ["b", "two", { n: 2 }]]);
  });
});

describe("OpenRouterAdapter.call", () => {
  const adapter = new OpenRouterAdapter("test/model", "sk-secret");
  const baseParams = { systemText: "SYSTEM", messages: [{ role: "user", content: "hi" }] as ChatMessage[], tools: [] as ToolDefinition[], maxTokens: 1024 };
  let fetchMock: ReturnType<typeof vi.fn>;

  function respondWith(body: unknown, init: ResponseInit = { status: 200 }) {
    fetchMock.mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), init));
  }
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0]![1].body as string);

  beforeEach(() => {
    recordCallDuration.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to OpenRouter with the bearer key and returns text, usage and the done flag", async () => {
    respondWith({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
    const turn = await adapter.call(baseParams);
    expect(turn).toEqual({ textContent: "pong", toolCalls: [], isDone: true, usage: { inputTokens: 11, outputTokens: 3 } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer sk-secret" });
    expect(sentBody().model).toBe("test/model");
    expect(sentBody().messages).toEqual([{ role: "system", content: "SYSTEM" }, { role: "user", content: "hi" }]);
  });

  it("raises a low max token request to the 4000 floor and keeps a higher one", async () => {
    respondWith({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    await adapter.call({ ...baseParams, maxTokens: 1024 });
    expect(sentBody().max_tokens).toBe(4000);
    fetchMock.mockClear();
    respondWith({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    await adapter.call({ ...baseParams, maxTokens: 9000 });
    expect(sentBody().max_tokens).toBe(9000);
  });

  it("omits the tools field when there are none and sends them when there are", async () => {
    respondWith({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    await adapter.call(baseParams);
    expect("tools" in sentBody()).toBe(false);
    fetchMock.mockClear();
    respondWith({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    await adapter.call({ ...baseParams, tools: [{ name: "list_waf_rules", description: "d", parameters: { type: "object", properties: {} } }] });
    expect(sentBody().tools).toEqual([{ type: "function", function: { name: "list_waf_rules", description: "d", parameters: { type: "object", properties: {} } } }]);
  });

  it("returns parsed tool calls and is not done on finish_reason tool_calls", async () => {
    respondWith({
      choices: [{ message: { content: null, tool_calls: [{ id: "call-1", function: { name: "unblock_ip", arguments: '{"ip":"9.9.9.9"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const turn = await adapter.call(baseParams);
    expect(turn.toolCalls).toEqual([{ id: "call-1", name: "unblock_ip", input: { ip: "9.9.9.9" } }]);
    expect(turn.isDone).toBe(false);
    expect(turn.textContent).toBe("");
  });

  it("reports zero usage when the response has none", async () => {
    respondWith({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    expect((await adapter.call(baseParams)).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("throws the status and body on an HTTP error, and does not retry", async () => {
    respondWith("rate limited", { status: 429 });
    await expect(adapter.call(baseParams)).rejects.toThrow("OpenRouter API 429: rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a 500 as well", async () => {
    respondWith("upstream down", { status: 500 });
    await expect(adapter.call(baseParams)).rejects.toThrow("OpenRouter API 500: upstream down");
  });

  it("throws when the body is not JSON", async () => {
    respondWith("<html>gateway timeout</html>", { status: 200 });
    await expect(adapter.call(baseParams)).rejects.toThrow(SyntaxError);
  });

  it("throws when the response has an empty choices list", async () => {
    respondWith({ choices: [] });
    await expect(adapter.call(baseParams)).rejects.toThrow("OpenRouter response had no choices.");
  });

  it("throws (rather than returning an empty turn) when a 200 response carries an error object instead of choices", async () => {
    respondWith({ error: { message: "model overloaded" } });
    await expect(adapter.call(baseParams)).rejects.toThrow("OpenRouter error: model overloaded");
  });

  it("names an error object that has no message", async () => {
    respondWith({ error: { code: 429 } });
    await expect(adapter.call(baseParams)).rejects.toThrow('OpenRouter error: {"code":429}');
  });

  it("throws when a tool call's arguments are malformed JSON", async () => {
    respondWith({ choices: [{ message: { content: null, tool_calls: [{ id: "c", function: { name: "t", arguments: "{oops" } }] }, finish_reason: "tool_calls" }] });
    await expect(adapter.call(baseParams)).rejects.toThrow(SyntaxError);
  });

  it("propagates a network failure and still records the call's duration", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    await expect(adapter.call(baseParams)).rejects.toThrow("socket hang up");
    expect(recordCallDuration).toHaveBeenCalledTimes(1);
    expect(recordCallDuration.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);
  });

  it("records the duration of an HTTP error response and of a success", async () => {
    respondWith("nope", { status: 401 });
    await expect(adapter.call(baseParams)).rejects.toThrow();
    respondWith({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    await adapter.call(baseParams);
    expect(recordCallDuration).toHaveBeenCalledTimes(2);
  });
});

describe("conversation helpers", () => {
  const adapter = new OpenRouterAdapter("m", "k");
  const turn = (overrides: Partial<ChatTurn>): ChatTurn => ({ textContent: "", toolCalls: [], isDone: false, usage: { inputTokens: 0, outputTokens: 0 }, ...overrides });

  it("appends an assistant message with text and its tool calls", () => {
    const messages: ChatMessage[] = [];
    adapter.appendAssistantMessage(messages, turn({ textContent: "on it", toolCalls: [{ id: "a", name: "t", input: {} }] }));
    expect(messages).toEqual([{ role: "assistant", content: "on it", toolCalls: [{ id: "a", name: "t", input: {} }] }]);
  });

  it("stores empty text as null and leaves toolCalls off when there are none", () => {
    const messages: ChatMessage[] = [];
    adapter.appendAssistantMessage(messages, turn({}));
    expect(messages).toEqual([{ role: "assistant", content: null }]);
    expect("toolCalls" in messages[0]!).toBe(false);
  });

  it("appends one tool message per result, keyed by tool call id", () => {
    const messages: ChatMessage[] = [];
    adapter.appendToolResults(messages, [{ id: "a", content: "1" }, { id: "b", content: "2" }]);
    expect(messages).toEqual([
      { role: "tool", content: "1", toolCallId: "a" },
      { role: "tool", content: "2", toolCallId: "b" },
    ]);
  });
});
