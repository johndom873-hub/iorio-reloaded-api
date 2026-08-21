// Ported from menaris-admin-api's utils/adapters/openai-adapter.js (the
// adapter Jack itself already uses — OpenRouter's chat-completions endpoint
// is OpenAI-format-compatible). Trimmed to non-streaming only (Telegram
// replies arrive as one message, not token-by-token) and OpenRouter-only
// (menaris's version abstracts over multiple OpenAI-compatible endpoints;
// Genosuke only ever talks to OpenRouter).

// Reasoning models can spend thinking tokens out of the same max_tokens
// budget without exposing them in the response content — a complex prompt
// can consume 1000+ thinking tokens before any visible output. Floors every
// call's budget so a low caller-supplied maxTokens can't silently zero out
// the output; raising the cap is free for non-reasoning models.
const MIN_MAX_TOKENS = 4000;

export type ChatRole = "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatTurn {
  textContent: string;
  toolCalls: ToolCall[];
  isDone: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

function toOpenAIMessages(systemText: string, messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: systemText }];

  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const hasCalls = (msg.toolCalls?.length ?? 0) > 0;
      // Some OpenAI-compatible endpoints require a non-empty content string
      // even when tool_calls is present.
      const entry: Record<string, unknown> = { role: "assistant", content: msg.content || (hasCalls ? "..." : "") };
      if (hasCalls) {
        entry.tool_calls = msg.toolCalls!.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }
      out.push(entry);
    } else if (msg.role === "tool") {
      out.push({ role: "tool", tool_call_id: msg.toolCallId, content: msg.content });
    }
  }
  return out;
}

function toOpenAITools(tools: ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

interface OpenAiChoice {
  message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  finish_reason: string;
}

function parseChoice(choice: OpenAiChoice): { textContent: string; toolCalls: ToolCall[]; isDone: boolean } {
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments || "{}"),
  }));
  const isDone = choice.finish_reason === "stop" || choice.finish_reason === "end_turn";
  return { textContent: choice.message.content ?? "", toolCalls, isDone };
}

export class OpenRouterAdapter {
  private readonly model: string;
  private readonly apiKey: string;
  private static readonly endpoint = "https://openrouter.ai/api/v1/chat/completions";

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.apiKey = apiKey;
  }

  async call(params: { systemText: string; messages: ChatMessage[]; tools: ToolDefinition[]; maxTokens: number }): Promise<ChatTurn> {
    const body = {
      model: this.model,
      messages: toOpenAIMessages(params.systemText, params.messages),
      max_tokens: Math.max(params.maxTokens, MIN_MAX_TOKENS),
      tools: params.tools.length > 0 ? toOpenAITools(params.tools) : undefined,
    };

    const response = await fetch(OpenRouterAdapter.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter API ${response.status}: ${await response.text()}`);
    }

    const json = (await response.json()) as { choices: OpenAiChoice[]; usage?: { prompt_tokens: number; completion_tokens: number } };
    const choice = json.choices[0];
    if (!choice) throw new Error("OpenRouter response had no choices.");
    const { textContent, toolCalls, isDone } = parseChoice(choice);
    return {
      textContent,
      toolCalls,
      isDone,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
    };
  }

  appendAssistantMessage(messages: ChatMessage[], turn: ChatTurn): void {
    const msg: ChatMessage = { role: "assistant", content: turn.textContent || null };
    if (turn.toolCalls.length > 0) msg.toolCalls = turn.toolCalls;
    messages.push(msg);
  }

  appendToolResults(messages: ChatMessage[], results: { id: string; content: string }[]): void {
    for (const r of results) {
      messages.push({ role: "tool", content: r.content, toolCallId: r.id });
    }
  }
}
