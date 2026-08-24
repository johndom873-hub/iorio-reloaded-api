// The stateless, tool-calling single-exchange loop — ported from
// menaris-admin-api's chatOnce() (analyst-agent-service.js), which Jack
// itself is built on. Same shape: caller owns and resends `messages` across
// turns (bot.ts's per-chat history Map), no S3/DB persistence here.
//
// Diverges from Jack in exactly one place: a financial-write tool call
// never reaches execute() from inside this loop. It's intercepted, turned
// into a pending Telegram confirmation, and the loop tells the model to
// stop rather than retry — see requestConfirmation.ts's header comment for
// why Jack's prompt-only "ask before acting" wasn't reused as-is.
import { OpenRouterAdapter, type ChatMessage } from "./openRouterAdapter.js";
import { TOOLS_BY_NAME } from "./tools/index.js";
import { createConfirmation } from "./confirmations.js";
import type { GenosukeApiClient } from "./apiClient.js";
import { GenosukeApiError } from "./apiClient.js";
import type { TelegramApi } from "./telegramApi.js";

const MAX_ITERATIONS = 8;
// ~5000 tokens at ~4 chars/token — generous for any single tool's result
// without letting one call bloat the whole context window.
const TOOL_RESULT_SIZE_LIMIT = 20_000;

const SYSTEM_PROMPT = `You are Genosuke, a Telegram assistant for Iorio Reloaded — a covered-calls / cash-secured-puts options trading platform for one two-person team (Marce and Juan). You have direct read access to positions, trade alerts, the trade blotter, risk settings, and screener data, and can take some actions on request.

Ground rules:
- Telegram doesn't render markdown here — reply in plain text, no headers/bold/bullets asterisks.
- Keep replies short: 1-4 sentences for a simple question. Only go longer if the user is asking for a real breakdown (e.g. "summarize my open positions").
- Never fabricate a number. Every figure you state must come from a tool call in this conversation — if you don't have it, call the right tool or say you don't have it.
- Dates/times you receive are ISO or already formatted — don't reformat them into a different convention than what you were given.
- Some tools have a financial consequence (creating/rolling/closing a position, rejecting an alert, changing risk settings). Calling one of those tools does NOT execute it — it sends the user a Yes/Cancel confirmation in Telegram, and only executes if they tap Yes. After calling one, just tell the user you've sent the confirmation; don't call it again in the same turn, and don't claim the action is done until you separately see it confirmed.
- If a request is ambiguous (which position, which strategy, which alert) ask one clarifying question rather than guessing on something with real financial consequence.`;

function capToolResult(result: unknown): string {
  const json = JSON.stringify(result);
  if (json.length <= TOOL_RESULT_SIZE_LIMIT) return json;
  return `${json.slice(0, TOOL_RESULT_SIZE_LIMIT)}… [truncated: result exceeded context limit]`;
}

export interface ChatOnceParams {
  messages: ChatMessage[];
  userMessage: string;
  chatId: string;
  adapter: OpenRouterAdapter;
  api: GenosukeApiClient;
  telegram: TelegramApi;
}

export async function chatOnce({ messages, userMessage, chatId, adapter, api, telegram }: ChatOnceParams): Promise<{ text: string }> {
  const toolDefinitions = [...TOOLS_BY_NAME.values()];
  messages.push({ role: "user", content: userMessage });

  let iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    const turn = await adapter.call({ systemText: SYSTEM_PROMPT, messages, tools: toolDefinitions, maxTokens: 1024 });
    adapter.appendAssistantMessage(messages, turn);

    if (turn.isDone || turn.toolCalls.length === 0) {
      return { text: turn.textContent };
    }

    const toolResults = await Promise.all(
      turn.toolCalls.map(async ({ id, name, input }) => {
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) return { id, content: `Error: unknown tool "${name}".` };

        if (tool.tier === "financial-write") {
          const confirmation = createConfirmation(chatId, name, input);
          const description = tool.describeForConfirmation?.(input) ?? name;
          await telegram.sendMessage(chatId, `Confirm: ${description}`, {
            buttons: [
              [
                { text: "Yes", callback_data: `confirm:${confirmation.id}` },
                { text: "Cancel", callback_data: `cancel:${confirmation.id}` },
              ],
            ],
          });
          return { id, content: "Sent a Yes/Cancel confirmation to the user in Telegram. Do not call this tool again — wait for them to respond." };
        }

        try {
          const result = await tool.execute(input, api);
          return { id, content: capToolResult(result) };
        } catch (error) {
          const message = error instanceof GenosukeApiError ? error.message : error instanceof Error ? error.message : String(error);
          // Otherwise a failed tool call is only ever visible as a paraphrased
          // sentence in Telegram — the real error text never reaches the logs.
          console.error(`Genosuke: tool "${name}" failed`, message);
          return { id, content: `Error: ${message}` };
        }
      }),
    );

    adapter.appendToolResults(messages, toolResults);
  }

  throw new Error("Genosuke chat: max iterations reached without a final response.");
}
