// Two-way Telegram bot — receives updates via Telegram webhook and answers
// questions via chatOnce()'s LLM/tool loop. Ported from menaris-admin-api's
// Jack (telegram-bot-service.js): webhook handler shape, chat-ID allowlist
// gate, and addressing detection all carry over close to as-is. Per-chat
// history is DB-backed (chatHistoryStore.ts) rather than Jack's in-memory
// approach — see PROGRESS.md's Genosuke entry for what else was
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
import { OpenRouterAdapter } from "./openRouterAdapter.js";
import { chatOnce } from "./chat.js";
import { loadRecentHistory, appendHistory } from "./chatHistoryStore.js";
import { takeConfirmation } from "./confirmations.js";
import { startOrderFollowUp } from "./orderFollowUp.js";
import { TOOLS_BY_NAME } from "./tools/index.js";
import { publishNotification } from "../lib/notificationChannel.js";

let started = false;
let runtime: { config: GenosukeConfig; telegram: TelegramApi; api: GenosukeApiClient; adapter: OpenRouterAdapter } | null = null;
let botId: number | null = null;
let botUsername: string | null = null;

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

// The quote is added for the bot's own messages too: scheduled alerts come from the same bot but never enter the chat
// history, so a bare "ready" replying to a "Gateway needs a manual login" alert would reach the model with no context.
export function prefixWithQuotedMessage(question: string, quotedText: string | undefined): string {
  return quotedText ? `[Replying to this message: "${quotedText.slice(0, 2000)}"]\n\n${question}` : question;
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

  const userMessage = prefixWithQuotedMessage(question, msg.reply_to_message?.text);

  const messages = await loadRecentHistory(chatId);
  const fromIndex = messages.length;
  try {
    const { text } = await chatOnce({ messages, userMessage, chatId, adapter, api, telegram });
    // A financial-write tool call sends its own Yes/Cancel confirmation
    // card directly (see chat.ts) and the model is told to reply with
    // nothing further — text can legitimately be empty here, and Telegram
    // rejects an empty sendMessage outright.
    if (text.trim()) {
      await telegram.sendMessage(chatId, text, { replyToMessageId: msg.message_id });
      // For Iorio Pulse's System Events feed — no per-user attribution
      // (chat-level auth only, see this file's header comment), just that a
      // reply went out.
      await publishNotification({ type: "genosuke_reply", preview: text.slice(0, 120) }).catch(() => {});
    }
  } catch (error) {
    console.error("Genosuke: chatOnce error", error);
    await telegram.sendMessage(chatId, "Sorry, hit an error answering that.", { replyToMessageId: msg.message_id });
  } finally {
    // Persist whatever chatOnce appended even on failure — e.g. the user's
    // own message should still be there for the next turn even if the LLM
    // call itself errored out.
    await appendHistory(chatId, messages, fromIndex).catch((error) => console.error("Genosuke: failed to persist chat history", error));
  }
}

// A confirmation card is resolved by a button tap, which the chat history never sees: without the reply stored
// there, the model believes the card is still waiting and refuses to send a fresh one.
async function replyAndRecord(telegram: TelegramApi, chatId: string, text: string): Promise<void> {
  await telegram.sendMessage(chatId, text);
  await appendHistory(chatId, [{ role: "assistant", content: text }], 0).catch((error) => console.error("Genosuke: could not record the reply in the chat history", error));
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
    await TOOLS_BY_NAME.get(confirmation.toolName)?.discardPrepared?.(confirmation.prepared, api).catch(() => {});
    await telegram.answerCallbackQuery(callbackQuery.id, "Cancelled.");
    await replyAndRecord(telegram, chatId, "Cancelled — no action taken.");
    return;
  }

  await telegram.answerCallbackQuery(callbackQuery.id, "Confirmed.");
  const tool = TOOLS_BY_NAME.get(confirmation.toolName);
  if (!tool) {
    await replyAndRecord(telegram, chatId, `Error: tool "${confirmation.toolName}" no longer exists.`);
    return;
  }

  try {
    const result = await tool.execute(confirmation.input, api, confirmation.prepared);
    const description = confirmation.description;
    if (tool.tracksOrderStatus && typeof (result as { id?: unknown })?.id === "string") {
      await replyAndRecord(telegram, chatId, `Sent to IBKR:\n${description}\nI'll tell you when it is placed, and again when it fills or ends.`);
    } else if (tool.describeResult) {
      await replyAndRecord(telegram, chatId, tool.describeResult(result));
    } else {
      await replyAndRecord(telegram, chatId, `Done:\n${description}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await replyAndRecord(telegram, chatId, `That failed: ${message}`);
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
      startOrderFollowUp(telegram, config.telegramChatId, config.serviceUsername);
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
