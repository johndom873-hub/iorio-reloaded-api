// Two-way Telegram bot — receives updates via Telegram webhook and answers
// questions via chatOnce()'s LLM/tool loop. Ported from menaris-admin-api's
// Jack (telegram-bot-service.js): webhook handler shape, chat-ID allowlist
// gate, addressing detection, and per-chat in-memory history all carry over
// close to as-is. See PROGRESS.md's Genosuke entry for what was
// deliberately NOT ported (Jack's prompt-only confirm flow) and why.
//
// Auth model (approved 2026-08-21): chat-level only, same as Jack — anyone
// in the allowed Telegram chat can use every tool Genosuke has. No
// per-user distinction between Marce and Juan.
//
// Privacy mode (BotFather, /setprivacy → Enable) is the real first line of
// defense — it stops Telegram from delivering ordinary unaddressed group
// messages to the webhook at all. The chat-id/is_bot filtering below is
// defense-in-depth on top of that, not the primary guard.
import type { Request, Response } from "express";
import { loadGenosukeConfig, type GenosukeConfig } from "./config.js";
import { TelegramApi, type TelegramUpdate } from "./telegramApi.js";
import { GenosukeApiClient } from "./apiClient.js";
import { OpenRouterAdapter, type ChatMessage } from "./openRouterAdapter.js";
import { chatOnce } from "./chat.js";
import { takeConfirmation } from "./confirmations.js";
import { TOOLS_BY_NAME } from "./tools/index.js";

const HISTORY_MAX_MESSAGES = 20;
// Stale chat context shouldn't leak into an unrelated new question hours later.
const HISTORY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ORDER_POLL_INTERVAL_MS = 5000;
const ORDER_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const ORDER_TERMINAL_STATUSES = new Set(["filled", "partially_filled", "cancelled", "error"]);

interface OrderRequestRow {
  id: string;
  status: string;
  error_message: string | null;
}

interface HistoryEntry {
  messages: ChatMessage[];
  lastActivity: number;
}

let started = false;
let runtime: { config: GenosukeConfig; telegram: TelegramApi; api: GenosukeApiClient; adapter: OpenRouterAdapter } | null = null;
let botId: number | null = null;
let botUsername: string | null = null;
const chatHistories = new Map<string, HistoryEntry>();

function getHistory(chatId: string): HistoryEntry {
  const entry = chatHistories.get(chatId);
  if (entry && Date.now() - entry.lastActivity < HISTORY_MAX_AGE_MS) return entry;
  const fresh: HistoryEntry = { messages: [], lastActivity: Date.now() };
  chatHistories.set(chatId, fresh);
  return fresh;
}

// Trims at a role:'user' boundary, never mid-turn — a naive length-based
// splice can orphan a tool-result message from its tool-call, which the
// LLM API rejects outright on the next call.
function trimHistory(entry: HistoryEntry): void {
  if (entry.messages.length <= HISTORY_MAX_MESSAGES) return;
  const cutFrom = entry.messages.length - HISTORY_MAX_MESSAGES;
  let boundary = entry.messages.findIndex((m, i) => i >= cutFrom && m.role === "user");
  if (boundary === -1) boundary = cutFrom;
  entry.messages.splice(0, boundary);
}

// Returns the addressed question text (trigger stripped), or null if the
// message isn't addressed to Genosuke at all.
function detectAddressing(msg: NonNullable<TelegramUpdate["message"]>): string | null {
  const text = msg.text ?? "";
  const entities = msg.entities ?? [];

  const command = entities.find((e) => e.type === "bot_command" && e.offset === 0);
  if (command) {
    const rest = text.slice(command.offset + command.length).trim();
    const cmdText = text.slice(command.offset, command.offset + command.length).toLowerCase();
    if (cmdText.startsWith("/ask")) return rest;
  }

  const mention = entities.find(
    (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${(botUsername ?? "").toLowerCase()}`,
  );
  if (mention) {
    return (text.slice(0, mention.offset) + text.slice(mention.offset + mention.length)).trim();
  }

  if (msg.reply_to_message?.from?.id === botId) {
    return text.trim();
  }

  if (msg.reply_to_message && /\bgenosuke\b/i.test(text)) {
    return text.trim();
  }

  return null;
}

async function handleMessage(
  msg: NonNullable<TelegramUpdate["message"]>,
  config: GenosukeConfig,
  telegram: TelegramApi,
  api: GenosukeApiClient,
  adapter: OpenRouterAdapter,
): Promise<void> {
  if (!msg.text) return;
  const chatId = String(msg.chat.id);
  if (chatId !== config.telegramChatId) return;
  if (msg.from?.is_bot) return;

  const question = detectAddressing(msg);
  if (question === null) return;

  if (!question) {
    await telegram.sendMessage(chatId, "What would you like to know?", { replyToMessageId: msg.message_id });
    return;
  }

  const quotedText = msg.reply_to_message?.from?.id !== botId ? msg.reply_to_message?.text : null;
  const userMessage = quotedText ? `[Replying to this message: "${quotedText.slice(0, 2000)}"]\n\n${question}` : question;

  const history = getHistory(chatId);
  try {
    const { text } = await chatOnce({ messages: history.messages, userMessage, chatId, adapter, api, telegram });
    history.lastActivity = Date.now();
    trimHistory(history);
    await telegram.sendMessage(chatId, text, { replyToMessageId: msg.message_id });
  } catch (error) {
    console.error("Genosuke: chatOnce error", error);
    await telegram.sendMessage(chatId, "Sorry, hit an error answering that.", { replyToMessageId: msg.message_id });
  }
}

function describeOrderOutcome(order: OrderRequestRow): string {
  switch (order.status) {
    case "filled":
      return "✅ Order filled — IBKR confirmed the trade.";
    case "partially_filled":
      return "⚠️ Order partially filled — check the Trade Blotter for the remaining quantity.";
    case "cancelled":
      return "Order was cancelled at IBKR — nothing was filled.";
    case "error":
      return `❌ Order failed: ${order.error_message ?? "unknown error"}.`;
    default:
      return `Order status: ${order.status}.`;
  }
}

// create_position/roll_position/close_position only confirm synchronously —
// the actual IBKR transmission happens async in worker.ts via Postgres
// LISTEN/NOTIFY (see positions.ts's /orders/:id/confirm), so the
// "confirmed" status right after Yes isn't the real outcome; contract
// resolution or IBKR itself can still reject it seconds later. Polls until
// a terminal status and sends a second message with what actually happened.
async function pollOrderAndFollowUp(chatId: string, orderId: string, telegram: TelegramApi, api: GenosukeApiClient): Promise<void> {
  const deadline = Date.now() + ORDER_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ORDER_POLL_INTERVAL_MS));
    let order: OrderRequestRow;
    try {
      order = await api.get<OrderRequestRow>(`/positions/orders/${orderId}`);
    } catch {
      continue; // transient API hiccup — keep polling until the timeout
    }
    if (ORDER_TERMINAL_STATUSES.has(order.status)) {
      await telegram.sendMessage(chatId, describeOrderOutcome(order));
      return;
    }
  }
  await telegram.sendMessage(chatId, "Still haven't heard back from IBKR on that order after 5 minutes — check the Trade Blotter, or ask me again shortly.");
}

async function handleCallbackQuery(
  callbackQuery: NonNullable<TelegramUpdate["callback_query"]>,
  config: GenosukeConfig,
  telegram: TelegramApi,
  api: GenosukeApiClient,
): Promise<void> {
  const chatId = callbackQuery.message ? String(callbackQuery.message.chat.id) : null;
  if (chatId !== config.telegramChatId) {
    await telegram.answerCallbackQuery(callbackQuery.id);
    return;
  }

  const data = callbackQuery.data ?? "";
  const [action, confirmationId] = data.split(":");
  if (!confirmationId || (action !== "confirm" && action !== "cancel")) {
    await telegram.answerCallbackQuery(callbackQuery.id);
    return;
  }

  const confirmation = takeConfirmation(confirmationId);
  if (!confirmation) {
    await telegram.answerCallbackQuery(callbackQuery.id, "This confirmation expired or was already resolved.");
    return;
  }

  // Belt-and-suspenders on top of takeConfirmation()'s single-use map (which
  // already makes a second tap a no-op at the execution level): strip the
  // buttons so a second tap doesn't even look actionable. Telegram leaves
  // inline buttons tappable indefinitely unless the message is edited.
  if (callbackQuery.message) {
    telegram.clearInlineKeyboard(chatId, callbackQuery.message.message_id);
  }

  if (action === "cancel") {
    await telegram.answerCallbackQuery(callbackQuery.id, "Cancelled.");
    await telegram.sendMessage(chatId, "Cancelled — no action taken.");
    return;
  }

  await telegram.answerCallbackQuery(callbackQuery.id, "Confirmed.");
  const tool = TOOLS_BY_NAME.get(confirmation.toolName);
  if (!tool) {
    await telegram.sendMessage(chatId, `Error: tool "${confirmation.toolName}" no longer exists.`);
    return;
  }

  try {
    const result = await tool.execute(confirmation.input, api);
    const description = tool.describeForConfirmation?.(confirmation.input) ?? tool.name;
    if (tool.tracksOrderStatus && typeof (result as { id?: unknown })?.id === "string") {
      await telegram.sendMessage(chatId, `Sent to IBKR — ${description} I'll follow up once it's placed or if anything fails.`);
      pollOrderAndFollowUp(chatId, (result as { id: string }).id, telegram, api).catch((error) => console.error("Genosuke: order poll failed", error));
    } else {
      await telegram.sendMessage(chatId, `Done — ${description}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await telegram.sendMessage(chatId, `That failed: ${message}`);
  }
}

export function startGenosuke(): void {
  if (started) return;
  const config = loadGenosukeConfig();
  if (!config) return; // loadGenosukeConfig already logs why
  started = true;

  const telegram = new TelegramApi(config.telegramBotToken);
  const api = new GenosukeApiClient(config);
  const adapter = new OpenRouterAdapter(config.openRouterModel, config.openRouterApiKey);
  runtime = { config, telegram, api, adapter };

  // Fire-and-forget: a Telegram-side startup failure must never crash the
  // web server. This project has no global unhandledRejection handler
  // (deliberately, see PROGRESS.md), so an uncaught rejection here would
  // take down the whole API process, not just the bot — every await below
  // is inside this try/catch specifically because of that.
  (async () => {
    try {
      const me = await telegram.getMe();
      botId = me.id;
      botUsername = me.username;
      console.info(`Genosuke: logged in as @${botUsername} (id=${botId})`);

      await telegram.setWebhook(config.webhookUrl, config.webhookSecret);
      console.info(`Genosuke: webhook registered at ${config.webhookUrl}`);
    } catch (error) {
      console.error("Genosuke: failed to start", error instanceof Error ? error.message : error);
    }
  })();
}

// Express handler for POST /genosuke/webhook. Acks fast (Telegram retries on
// non-2xx or timeout, which would otherwise redeliver the same update
// repeatedly) and processes the update after responding.
export function handleGenosukeWebhook(request: Request, response: Response): void {
  if (!runtime) {
    response.sendStatus(404);
    return;
  }
  if (request.get("X-Telegram-Bot-Api-Secret-Token") !== runtime.config.webhookSecret) {
    response.sendStatus(401);
    return;
  }
  response.sendStatus(200);

  const update = request.body as TelegramUpdate | undefined;
  const { config, telegram, api, adapter } = runtime;
  if (update?.message) {
    handleMessage(update.message, config, telegram, api, adapter).catch((error) => console.error("Genosuke: message handler error", error));
  } else if (update?.callback_query) {
    handleCallbackQuery(update.callback_query, config, telegram, api).catch((error) => console.error("Genosuke: callback handler error", error));
  }
}
