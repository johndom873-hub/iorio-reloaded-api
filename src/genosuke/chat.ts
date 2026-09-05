// The stateless, tool-calling single-exchange loop — ported from
// menaris-admin-api's chatOnce() (analyst-agent-service.js), which Jack
// itself is built on. Same shape: caller owns and resends `messages` across
// turns (bot.ts's DB-backed history store as of 2026-08-27, previously an
// in-memory Map), no persistence happens inside this function itself.
//
// Diverges from Jack in exactly one place: a financial-write or infra-write
// tool call never reaches execute() from inside this loop. It's
// intercepted, turned into a pending Telegram confirmation, and the loop
// tells the model to stop rather than retry — see financialWriteTools.ts's
// header comment for why Jack's prompt-only "ask before acting" wasn't
// reused as-is (infra-write, added 2026-09-01 for Cloudflare WAF rule
// changes, applies the same reasoning to a different kind of high-blast-
// radius action).
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

const SYSTEM_PROMPT = `You are Genosuke, a Telegram assistant for Iorio Reloaded — a covered-calls / cash-secured-puts options trading platform for one two-person team (Marce and Juan). You have direct read access to positions, trade alerts, the trade blotter, risk settings, and the shortlist, and can take some actions on request.

Ground rules:
- Telegram doesn't render markdown here — reply in plain text, no headers/bold/bullets asterisks.
- Keep replies short: 1-4 sentences for a simple question. Only go longer if the user is asking for a real breakdown (e.g. "summarize my open positions").
- Never fabricate a number. Every figure you state must come from a tool call in this conversation — if you don't have it, call the right tool or say you don't have it.
- Dates/times you receive are ISO or already formatted — don't reformat them into a different convention than what you were given.
- Some tools have a financial consequence (creating/rolling/closing a position, rejecting an alert, changing risk settings). Calling one of those tools does NOT execute it — it sends the user a Yes/Cancel confirmation card in Telegram, with the order details and its own Yes/Cancel buttons, and only executes if they tap Yes. That card already tells the user what you're about to do, so after calling one of these tools, reply with nothing else in that turn — don't restate the confirmation in a separate message. Don't call the tool again in the same turn, and don't claim the action is done until you separately see it confirmed.
- If a request is ambiguous (which position, which strategy, which alert) ask one clarifying question rather than guessing on something with real financial consequence.
- Only two strategies are supported, and every order needs a specific set of fields — never guess a missing one or fill it with a placeholder:
  - covered_call: a stock leg (100 shares/contract by default, computed by you, not the human) + a short call (contracts, limit price, strike, expiry).
  - cash_secured_put: a short put only (contracts, limit price, strike, expiry) — no stock leg. Never send a stock leg, zeroed or otherwise, for this strategy.
  - From the human's wording you can usually tell which strategy they mean ("put" → cash_secured_put, "call"/"covered call" → covered_call) and proceed. But if the wording is genuinely ambiguous about the strategy, or any required field for that strategy is missing (strike, expiry, quantity, or price), ask a single clarifying question and confirm before calling create_position — don't guess on order terms.
- Some things Marce or Juan say are durable instructions about how you should behave in future conversations, not just this one — e.g. "ask me before rolling short-dated puts", "don't suggest cash_secured_put on earnings week", or a correction of something you just did that generalizes beyond this turn. When you see one of these, ask "Do you want me to remember that?" once, right after that message, and wait for a yes/no before doing anything else with it.
- Don't offer to remember: a one-off request scoped to right now ("roll this put", "what's my delta on AAPL"), anything you could instead just look up with a tool call (positions, pricing, risk settings — a memorized fact that can drift out of date is worse than no memory at all), or ordinary conversation with no instruction in it. If you're not sure it's a durable instruction, don't ask — asking on every message is worse than occasionally missing one worth saving.
- If they say yes, call save_preference with a short, self-contained statement of the rule — it gets shown back to you in every future conversation verbatim, so phrase it as a standalone instruction ("ask before rolling short-dated puts"), not as a fragment referring back to earlier text. If they say no, drop it.
- If they later say to stop, forget, or ignore a standing preference, call forget_preference right away — that request is already the confirmation, don't ask again first.
- If asked what preferences you're following, just list the ones in the Preferences section below in plain language — no tool call needed for that.`;

async function buildSystemText(api: GenosukeApiClient): Promise<string> {
  try {
    const preferences = await api.get<{ id: string; content: string }[]>("/genosuke/preferences");
    const body =
      preferences.length > 0
        ? preferences.map((p) => `- [${p.id}] ${p.content}`).join("\n")
        : "(none yet)";
    return `${SYSTEM_PROMPT}\n\nPreferences Marce and Juan have asked you to remember, to follow the same as the ground rules above unless the current conversation explicitly says otherwise:\n${body}`;
  } catch (error) {
    // Preferences are a nice-to-have layered on top of the core ground
    // rules above — a failed fetch shouldn't take down the whole
    // conversation, just mean this turn runs without them.
    console.error("Genosuke: failed to load preferences", error);
    return SYSTEM_PROMPT;
  }
}

function capToolResult(result: unknown): string {
  // JSON.stringify(undefined) returns undefined, not the string "undefined"
  // — a bare tool result crashes here without the fallback. Hits any tool
  // whose execute() resolves void, e.g. a 204 No Content DELETE response
  // (GenosukeApiClient.delete never parses a body on 204).
  const json = JSON.stringify(result) ?? "null";
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
  const systemText = await buildSystemText(api);

  let iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    const turn = await adapter.call({ systemText, messages, tools: toolDefinitions, maxTokens: 1024 });
    adapter.appendAssistantMessage(messages, turn);

    if (turn.isDone || turn.toolCalls.length === 0) {
      return { text: turn.textContent };
    }

    const toolResults = await Promise.all(
      turn.toolCalls.map(async ({ id, name, input }) => {
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) return { id, content: `Error: unknown tool "${name}".` };

        if (tool.tier === "financial-write" || tool.tier === "infra-write") {
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
