import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

// The Yes/Cancel button handling of bot.ts, driven through the exported webhook handler with every collaborator faked:
// Telegram, the API client, the tools, the chat history and the order follow-up.
const hoisted = vi.hoisted(() => ({
  telegram: {
    getMe: vi.fn(),
    setWebhook: vi.fn(),
    sendMessage: vi.fn(),
    answerCallbackQuery: vi.fn(),
    clearInlineKeyboard: vi.fn(),
  },
  api: { name: "fake-api" },
  tools: new Map<string, unknown>(),
  startOrderFollowUp: vi.fn(),
  appendHistory: vi.fn(),
}));

vi.mock("./config.js", () => ({
  loadGenosukeConfig: () => ({
    telegramBotToken: "token",
    telegramChatId: "123",
    openRouterApiKey: "key",
    openRouterModel: "model",
    serviceUsername: "genosuke-svc",
    serviceUserPassword: "pw",
    webhookUrl: "https://example.test/hook",
    webhookSecret: "secret",
    apiBaseUrl: "http://127.0.0.1:1",
  }),
}));
vi.mock("./telegramApi.js", () => ({
  TelegramApi: class {
    constructor() {
      return hoisted.telegram;
    }
  },
}));
vi.mock("./apiClient.js", () => ({
  GenosukeApiClient: class {
    constructor() {
      return hoisted.api;
    }
  },
}));
vi.mock("./openRouterAdapter.js", () => ({ OpenRouterAdapter: class {} }));
vi.mock("./chat.js", () => ({ chatOnce: vi.fn() }));
vi.mock("./chatHistoryStore.js", () => ({ loadRecentHistory: vi.fn(async () => []), appendHistory: (...args: unknown[]) => hoisted.appendHistory(...args) }));
vi.mock("./tools/index.js", () => ({ TOOLS_BY_NAME: hoisted.tools }));
vi.mock("./orderFollowUp.js", () => ({ startOrderFollowUp: (...args: unknown[]) => hoisted.startOrderFollowUp(...args) }));
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification: vi.fn(async () => {}) }));

const { startGenosuke, handleGenosukeWebhook, detectAddressing, handleMessage } = await import("./bot.js");
const { chatOnce } = await import("./chat.js");
const { loadRecentHistory } = await import("./chatHistoryStore.js");
const { publishNotification } = await import("../lib/notificationChannel.js");
import type { GenosukeConfig } from "./config.js";
import type { TelegramApi, TelegramUpdate } from "./telegramApi.js";
import type { GenosukeApiClient } from "./apiClient.js";
import type { OpenRouterAdapter } from "./openRouterAdapter.js";
const { createConfirmation } = await import("./confirmations.js");

const { telegram } = hoisted;

beforeAll(async () => {
  telegram.getMe.mockResolvedValue({ id: 1, username: "genosuke_bot" });
  telegram.setWebhook.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
  startGenosuke();
  await vi.waitFor(() => expect(hoisted.startOrderFollowUp).toHaveBeenCalled());
});

beforeEach(() => {
  telegram.sendMessage.mockReset().mockResolvedValue(undefined);
  telegram.answerCallbackQuery.mockReset().mockResolvedValue(undefined);
  telegram.clearInlineKeyboard.mockReset().mockResolvedValue(undefined);
  hoisted.appendHistory.mockReset().mockResolvedValue(undefined);
  hoisted.tools.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tap(data: string, options: { chatId?: number; secret?: string } = {}) {
  const response = { sendStatus: vi.fn() };
  const request = {
    get: (name: string) => (name === "X-Telegram-Bot-Api-Secret-Token" ? (options.secret ?? "secret") : undefined),
    body: { callback_query: { id: "cb-1", data, message: { chat: { id: options.chatId ?? 123 }, message_id: 9 } } },
  };
  handleGenosukeWebhook(request as unknown as Request, response as unknown as Response);
  return response;
}

function orderTool(overrides: Record<string, unknown> = {}) {
  const tool = { name: "create_position", tier: "financial-write", tracksOrderStatus: true, execute: vi.fn(async () => ({ id: "order-1", status: "confirmed" })), discardPrepared: vi.fn(async () => {}), ...overrides };
  hoisted.tools.set(tool.name as string, tool);
  return tool as typeof tool & { execute: ReturnType<typeof vi.fn>; discardPrepared: ReturnType<typeof vi.fn> };
}

const lastReply = () => telegram.sendMessage.mock.calls.at(-1)![1] as string;

describe("startup", () => {
  it("starts the order follow-up once the webhook is registered, for the configured chat and service user", () => {
    expect(hoisted.startOrderFollowUp).toHaveBeenCalledTimes(1);
    expect(hoisted.startOrderFollowUp).toHaveBeenCalledWith(telegram, "123", "genosuke-svc");
    expect(telegram.setWebhook.mock.invocationCallOrder[0]!).toBeLessThan(hoisted.startOrderFollowUp.mock.invocationCallOrder[0]!);
  });
});

describe("the webhook", () => {
  it("answers 401 to a wrong secret and does nothing", () => {
    const tool = orderTool();
    const confirmation = createConfirmation("123", "create_position", {}, "CARD", { orderId: "order-1" });
    const response = tap(`confirm:${confirmation.id}`, { secret: "wrong" });
    expect(response.sendStatus).toHaveBeenCalledWith(401);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("ignores a tap from another chat without consuming the card", async () => {
    const tool = orderTool();
    const confirmation = createConfirmation("123", "create_position", {}, "CARD", { orderId: "order-1" });
    tap(`confirm:${confirmation.id}`, { chatId: 999 });
    await vi.waitFor(() => expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("cb-1"));
    expect(tool.execute).not.toHaveBeenCalled();
    tap(`confirm:${confirmation.id}`);
    await vi.waitFor(() => expect(tool.execute).toHaveBeenCalledTimes(1));
  });
});

describe("tapping Yes", () => {
  it("executes the tool with the card's input AND the prepared order, then tells the human it was sent", async () => {
    const tool = orderTool();
    const prepared = { orderId: "order-1" };
    const input = { symbol: "AAOI" };
    const confirmation = createConfirmation("123", "create_position", input, "CARD", prepared);
    tap(`confirm:${confirmation.id}`);
    await vi.waitFor(() => expect(lastReply()).toContain("Sent to IBKR"));
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(tool.execute.mock.calls[0]![0]).toBe(input);
    expect(tool.execute.mock.calls[0]![1]).toBe(hoisted.api);
    expect(tool.execute.mock.calls[0]![2]).toBe(prepared);
    expect(lastReply()).toBe("Sent to IBKR:\nCARD\nI'll tell you when it is placed, and again when it fills or ends.");
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("cb-1", "Confirmed.");
    expect(telegram.clearInlineKeyboard).toHaveBeenCalledWith("123", 9);
    expect(hoisted.appendHistory).toHaveBeenCalled();
    expect(tool.discardPrepared).not.toHaveBeenCalled();
  });

  it("a second tap on the same card is told it was already resolved and executes nothing more", async () => {
    const tool = orderTool();
    const confirmation = createConfirmation("123", "create_position", {}, "CARD", { orderId: "order-1" });
    tap(`confirm:${confirmation.id}`);
    await vi.waitFor(() => expect(tool.execute).toHaveBeenCalledTimes(1));
    tap(`confirm:${confirmation.id}`);
    await vi.waitFor(() => expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("cb-1", "This confirmation expired or was already resolved."));
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it("reports a failed execute to the human", async () => {
    orderTool({
      execute: vi.fn(async () => {
        throw new Error("Trading is blocked: wrong account.");
      }),
    });
    const confirmation = createConfirmation("123", "create_position", {}, "CARD", { orderId: "order-1" });
    tap(`confirm:${confirmation.id}`);
    await vi.waitFor(() => expect(lastReply()).toBe("That failed: Trading is blocked: wrong account."));
  });

  it("a tool that does not track an order says Done with the card text, or its own result text when it has one", async () => {
    orderTool({ name: "update_risk_limits", tracksOrderStatus: undefined, execute: vi.fn(async () => ({ saved: true })) });
    const done = createConfirmation("123", "update_risk_limits", {}, "Update the trading limits", undefined);
    tap(`confirm:${done.id}`);
    await vi.waitFor(() => expect(lastReply()).toBe("Done:\nUpdate the trading limits"));

    orderTool({ name: "update_risk_limits", tracksOrderStatus: undefined, execute: vi.fn(async () => ({ saved: true })), describeResult: () => "Limits updated." });
    const described = createConfirmation("123", "update_risk_limits", {}, "Update the trading limits", undefined);
    tap(`confirm:${described.id}`);
    await vi.waitFor(() => expect(lastReply()).toBe("Limits updated."));
  });

  it("says so when the tool no longer exists", async () => {
    const confirmation = createConfirmation("123", "retired_tool", {}, "CARD", undefined);
    tap(`confirm:${confirmation.id}`);
    await vi.waitFor(() => expect(lastReply()).toBe('Error: tool "retired_tool" no longer exists.'));
  });
});

describe("tapping Cancel", () => {
  it("discards the prepared order (cancelling it) and executes nothing", async () => {
    const tool = orderTool();
    const prepared = { orderId: "order-1" };
    const confirmation = createConfirmation("123", "create_position", {}, "CARD", prepared);
    tap(`cancel:${confirmation.id}`);
    await vi.waitFor(() => expect(lastReply()).toBe("Cancelled — no action taken."));
    expect(tool.discardPrepared).toHaveBeenCalledTimes(1);
    expect(tool.discardPrepared.mock.calls[0]![0]).toBe(prepared);
    expect(tool.discardPrepared.mock.calls[0]![1]).toBe(hoisted.api);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("cb-1", "Cancelled.");
  });

  it("still cancels cleanly when discarding the prepared order fails", async () => {
    const tool = orderTool({
      discardPrepared: vi.fn(async () => {
        throw new Error("already cancelled");
      }),
    });
    const confirmation = createConfirmation("123", "create_position", {}, "CARD", { orderId: "order-1" });
    tap(`cancel:${confirmation.id}`);
    await vi.waitFor(() => expect(lastReply()).toBe("Cancelled — no action taken."));
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("cancels a tool that has nothing to discard", async () => {
    orderTool({ name: "update_risk_limits", discardPrepared: undefined });
    const confirmation = createConfirmation("123", "update_risk_limits", {}, "CARD", undefined);
    tap(`cancel:${confirmation.id}`);
    await vi.waitFor(() => expect(lastReply()).toBe("Cancelled — no action taken."));
  });

  it("a Cancel after a Yes finds nothing to cancel, so a confirmed order is never discarded by a late tap", async () => {
    const tool = orderTool();
    const confirmation = createConfirmation("123", "create_position", {}, "CARD", { orderId: "order-1" });
    tap(`confirm:${confirmation.id}`);
    await vi.waitFor(() => expect(tool.execute).toHaveBeenCalledTimes(1));
    tap(`cancel:${confirmation.id}`);
    await vi.waitFor(() => expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("cb-1", "This confirmation expired or was already resolved."));
    expect(tool.discardPrepared).not.toHaveBeenCalled();
  });
});

type TelegramMessage = NonNullable<TelegramUpdate["message"]>;

/** A plain text message in the allowed chat from a human; overrides replace any field. */
function textMessage(text: string, overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return { message_id: 50, text, chat: { id: 123, type: "supergroup" }, from: { id: 7, is_bot: false }, ...overrides };
}

/** Entities for `text` where `needle` is a bot_command or mention. */
function entityFor(text: string, needle: string, type: "bot_command" | "mention") {
  return { type, offset: text.indexOf(needle), length: needle.length };
}

describe("detectAddressing", () => {
  // The bot logs in as @genosuke_bot with id 1 at startup (see beforeAll).
  it("takes the text after /ask as the question", () => {
    const text = "/ask what is my delta";
    expect(detectAddressing(textMessage(text, { entities: [entityFor(text, "/ask", "bot_command")] }))).toBe("what is my delta");
  });

  it("accepts /ask@genosuke_bot and any letter case of the command", () => {
    const withSuffix = "/ask@genosuke_bot hello";
    expect(detectAddressing(textMessage(withSuffix, { entities: [entityFor(withSuffix, "/ask@genosuke_bot", "bot_command")] }))).toBe("hello");
    const upper = "/ASK hello";
    expect(detectAddressing(textMessage(upper, { entities: [entityFor(upper, "/ASK", "bot_command")] }))).toBe("hello");
  });

  it.each(["/asking what is my delta", "/askme what is my delta", "/ask@other_bot what is my delta", "/ask_more x"])("does not answer %s (a different command, or one addressed to another bot)", (text) => {
    const command = text.split(" ")[0]!;
    expect(detectAddressing(textMessage(text, { entities: [entityFor(text, command, "bot_command")] }))).toBeNull();
  });

  it("returns an empty question for a bare /ask (so the bot can ask what is wanted)", () => {
    expect(detectAddressing(textMessage("/ask", { entities: [{ type: "bot_command", offset: 0, length: 4 }] }))).toBe("");
    expect(detectAddressing(textMessage("/ask   ", { entities: [{ type: "bot_command", offset: 0, length: 4 }] }))).toBe("");
  });

  it("ignores a command that is not at the start of the message", () => {
    const text = "hey /ask something";
    expect(detectAddressing(textMessage(text, { entities: [entityFor(text, "/ask", "bot_command")] }))).toBeNull();
  });

  it("ignores other commands in an unaddressed message", () => {
    expect(detectAddressing(textMessage("/status now", { entities: [{ type: "bot_command", offset: 0, length: 7 }] }))).toBeNull();
  });

  it("answers an @mention with the mention cut out and the rest trimmed", () => {
    const leading = "@genosuke_bot what is open?";
    expect(detectAddressing(textMessage(leading, { entities: [entityFor(leading, "@genosuke_bot", "mention")] }))).toBe("what is open?");
    const trailing = "what is open? @genosuke_bot";
    expect(detectAddressing(textMessage(trailing, { entities: [entityFor(trailing, "@genosuke_bot", "mention")] }))).toBe("what is open?");
    const middle = "hey @genosuke_bot any news";
    expect(detectAddressing(textMessage(middle, { entities: [entityFor(middle, "@genosuke_bot", "mention")] }))).toBe("hey  any news");
  });

  it("matches the mention case-insensitively", () => {
    const text = "@Genosuke_BOT ping";
    expect(detectAddressing(textMessage(text, { entities: [entityFor(text, "@Genosuke_BOT", "mention")] }))).toBe("ping");
  });

  it("returns an empty question for a mention with nothing else", () => {
    expect(detectAddressing(textMessage("@genosuke_bot", { entities: [{ type: "mention", offset: 0, length: 13 }] }))).toBe("");
  });

  it("ignores a mention of a different account", () => {
    const text = "@another_bot hello";
    expect(detectAddressing(textMessage(text, { entities: [entityFor(text, "@another_bot", "mention")] }))).toBeNull();
  });

  it("ignores a longer username that merely starts with the bot's", () => {
    const text = "@genosuke_bot_two hello";
    expect(detectAddressing(textMessage(text, { entities: [entityFor(text, "@genosuke_bot_two", "mention")] }))).toBeNull();
  });

  it("answers a reply to one of the bot's own messages, whatever the text", () => {
    expect(detectAddressing(textMessage("  ready  ", { reply_to_message: { message_id: 40, from: { id: 1 }, text: "Gateway needs a login" } }))).toBe("ready");
  });

  it("ignores a reply to someone else's message", () => {
    expect(detectAddressing(textMessage("agreed", { reply_to_message: { message_id: 40, from: { id: 99 }, text: "ok" } }))).toBeNull();
  });

  it("ignores a reply to a message with no sender", () => {
    expect(detectAddressing(textMessage("agreed", { reply_to_message: { message_id: 40, text: "ok" } }))).toBeNull();
  });

  it("answers a reply to someone else that contains the word genosuke", () => {
    expect(detectAddressing(textMessage("Genosuke, can you check this?", { reply_to_message: { message_id: 40, from: { id: 99 } } }))).toBe("Genosuke, can you check this?");
    expect(detectAddressing(textMessage("ask GENOSUKE", { reply_to_message: { message_id: 40, from: { id: 99 } } }))).toBe("ask GENOSUKE");
  });

  it("needs the whole word genosuke, and a reply, to trigger that way", () => {
    expect(detectAddressing(textMessage("genosukes are great", { reply_to_message: { message_id: 40, from: { id: 99 } } }))).toBeNull();
    expect(detectAddressing(textMessage("genosuke, are you there?"))).toBeNull();
  });

  it("ignores ordinary chat, including a message with no text field", () => {
    expect(detectAddressing(textMessage("lunch?"))).toBeNull();
    expect(detectAddressing({ message_id: 1, chat: { id: 123, type: "supergroup" } })).toBeNull();
  });

  it("lets /ask win over a mention in the same message", () => {
    const text = "/ask @genosuke_bot hi";
    const entities = [entityFor(text, "/ask", "bot_command"), entityFor(text, "@genosuke_bot", "mention")];
    expect(detectAddressing(textMessage(text, { entities }))).toBe("@genosuke_bot hi");
  });
});

describe("handleMessage", () => {
  const config = { telegramChatId: "123" } as GenosukeConfig;
  const adapter = { name: "fake-adapter" } as unknown as OpenRouterAdapter;
  const chatOnceMock = vi.mocked(chatOnce);
  const loadHistoryMock = vi.mocked(loadRecentHistory);
  const publishMock = vi.mocked(publishNotification);
  const apiClient = hoisted.api as unknown as GenosukeApiClient;
  const telegramApi = telegram as unknown as TelegramApi;

  const handle = (message: TelegramMessage) => handleMessage(message, config, telegramApi, apiClient, adapter);
  const addressed = (text = "@genosuke_bot how are we doing?", overrides: Partial<TelegramMessage> = {}) =>
    textMessage(text, { entities: [{ type: "mention", offset: text.indexOf("@genosuke_bot"), length: 13 }], ...overrides });

  beforeEach(() => {
    chatOnceMock.mockReset().mockResolvedValue({ text: "All good." });
    loadHistoryMock.mockReset().mockResolvedValue([]);
    publishMock.mockReset().mockResolvedValue(undefined);
  });

  it("ignores a message with no text", async () => {
    await handle({ message_id: 1, chat: { id: 123, type: "supergroup" }, from: { id: 7, is_bot: false } });
    expect(chatOnceMock).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores every message from a chat other than the configured one, even when addressed to the bot", async () => {
    await handle(addressed("@genosuke_bot close everything", { chat: { id: 999, type: "private" } }));
    expect(loadHistoryMock).not.toHaveBeenCalled();
    expect(chatOnceMock).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("compares the chat id as a string, so a group's negative id matches its configured value", async () => {
    await handleMessage(addressed("@genosuke_bot hi", { chat: { id: -1001234, type: "supergroup" } }), { telegramChatId: "-1001234" } as GenosukeConfig, telegramApi, apiClient, adapter);
    expect(chatOnceMock).toHaveBeenCalledTimes(1);
  });

  it("ignores messages sent by other bots", async () => {
    await handle(addressed("@genosuke_bot hi", { from: { id: 8, is_bot: true } }));
    expect(chatOnceMock).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("treats a message with no sender as a human (channel-style posts still reach the chat gate)", async () => {
    await handle(addressed("@genosuke_bot hi", { from: undefined }));
    expect(chatOnceMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a message that is not addressed to the bot, without loading history", async () => {
    await handle(textMessage("anyone want lunch?"));
    expect(loadHistoryMock).not.toHaveBeenCalled();
    expect(chatOnceMock).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("asks what is wanted for an empty question, replying to the message, without calling the model", async () => {
    await handle(textMessage("/ask", { entities: [{ type: "bot_command", offset: 0, length: 4 }], message_id: 77 }));
    expect(telegram.sendMessage).toHaveBeenCalledWith("123", "What would you like to know?", { replyToMessageId: 77 });
    expect(chatOnceMock).not.toHaveBeenCalled();
  });

  it("answers an addressed question: runs the model on the stored history, replies to the message, and records the reply for Pulse", async () => {
    const history = [{ role: "user" as const, content: "earlier" }, { role: "assistant" as const, content: "earlier answer" }];
    loadHistoryMock.mockResolvedValue(history);
    await handle(addressed("@genosuke_bot how are we doing?", { message_id: 61 }));

    expect(chatOnceMock).toHaveBeenCalledTimes(1);
    const params = chatOnceMock.mock.calls[0]![0];
    expect(params.userMessage).toBe("how are we doing?");
    expect(params.chatId).toBe("123");
    expect(params.messages).toBe(history);
    expect(params.api).toBe(apiClient);
    expect(params.telegram).toBe(telegramApi);
    expect(params.adapter).toBe(adapter);
    expect(telegram.sendMessage).toHaveBeenCalledWith("123", "All good.", { replyToMessageId: 61 });
    expect(publishMock).toHaveBeenCalledWith({ type: "genosuke_reply", preview: "All good." });
  });

  it("persists only what this turn added: from the length of the history loaded before the call", async () => {
    const history = [{ role: "user" as const, content: "earlier" }];
    loadHistoryMock.mockResolvedValue(history);
    chatOnceMock.mockImplementation(async ({ messages }) => {
      messages.push({ role: "user", content: "q" }, { role: "assistant", content: "a" });
      return { text: "a" };
    });
    await handle(addressed());
    expect(hoisted.appendHistory).toHaveBeenCalledTimes(1);
    expect(hoisted.appendHistory).toHaveBeenCalledWith("123", history, 1);
    expect(history).toHaveLength(3);
  });

  it("caps the Pulse preview at 120 characters while sending the whole reply", async () => {
    const longReply = "x".repeat(300);
    chatOnceMock.mockResolvedValue({ text: longReply });
    await handle(addressed());
    expect(lastReply()).toBe(longReply);
    expect(publishMock).toHaveBeenCalledWith({ type: "genosuke_reply", preview: "x".repeat(120) });
  });

  it("gives the model the quoted message a reply refers to", async () => {
    await handle(textMessage("ready", { reply_to_message: { message_id: 40, from: { id: 1 }, text: "Gateway needs a manual login" } }));
    expect(chatOnceMock.mock.calls[0]![0].userMessage).toBe('[Replying to this message: "Gateway needs a manual login"]\n\nready');
  });

  it("sends nothing when the model's turn produced no text (a confirmation card already went out), but still saves history", async () => {
    chatOnceMock.mockResolvedValue({ text: "" });
    await handle(addressed());
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(hoisted.appendHistory).toHaveBeenCalledTimes(1);
  });

  it("treats a whitespace-only reply as empty", async () => {
    chatOnceMock.mockResolvedValue({ text: "  \n " });
    await handle(addressed());
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("replies with an apology when the model call fails, and still saves history", async () => {
    chatOnceMock.mockRejectedValue(new Error("OpenRouter API 500: boom"));
    await handle(addressed("@genosuke_bot hello", { message_id: 88 }));
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("123", "Sorry, hit an error answering that.", { replyToMessageId: 88 });
    expect(publishMock).not.toHaveBeenCalled();
    expect(hoisted.appendHistory).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("does not tell the user about a failed Pulse notification", async () => {
    publishMock.mockRejectedValue(new Error("notify channel down"));
    await handle(addressed());
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(lastReply()).toBe("All good.");
  });

  it("does not let a failed history save break the reply", async () => {
    hoisted.appendHistory.mockRejectedValue(new Error("db down"));
    await expect(handle(addressed())).resolves.toBeUndefined();
    expect(lastReply()).toBe("All good.");
    expect(console.error).toHaveBeenCalledWith("Genosuke: failed to persist chat history", expect.any(Error));
  });

  it("does not call the model when the history cannot be loaded, and tells the person instead of staying silent", async () => {
    loadHistoryMock.mockRejectedValue(new Error("db down"));
    await handle(addressed());
    expect(chatOnceMock).not.toHaveBeenCalled();
    expect(lastReply()).toBe("Sorry, hit an error answering that.");
    expect(console.error).toHaveBeenCalledWith("Genosuke: could not load the chat history", expect.any(Error));
  });
});

describe("a message update through the webhook", () => {
  const messageUpdate = (secret = "secret") => {
    const response = { sendStatus: vi.fn() };
    const text = "@genosuke_bot status?";
    const request = {
      get: (name: string) => (name === "X-Telegram-Bot-Api-Secret-Token" ? secret : undefined),
      body: { message: textMessage(text, { entities: [{ type: "mention", offset: 0, length: 13 }] }) },
    };
    handleGenosukeWebhook(request as unknown as Request, response as unknown as Response);
    return response;
  };

  beforeEach(() => {
    vi.mocked(chatOnce).mockReset().mockResolvedValue({ text: "fine" });
    vi.mocked(loadRecentHistory).mockReset().mockResolvedValue([]);
  });

  it("is answered after acknowledging with 200", async () => {
    const response = messageUpdate();
    expect(response.sendStatus).toHaveBeenCalledWith(200);
    await vi.waitFor(() => expect(lastReply()).toBe("fine"));
  });

  it("is rejected with 401 and never reaches the model when the secret is wrong", async () => {
    const response = messageUpdate("wrong");
    expect(response.sendStatus).toHaveBeenCalledWith(401);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chatOnce).not.toHaveBeenCalled();
  });

  it("acknowledges an update that carries neither a message nor a callback", async () => {
    const response = { sendStatus: vi.fn() };
    const request = { get: () => "secret", body: { update_id: 5 } };
    handleGenosukeWebhook(request as unknown as Request, response as unknown as Response);
    expect(response.sendStatus).toHaveBeenCalledWith(200);
    expect(chatOnce).not.toHaveBeenCalled();
  });

  it("acknowledges an update with no body at all", () => {
    const response = { sendStatus: vi.fn() };
    handleGenosukeWebhook({ get: () => "secret", body: undefined } as unknown as Request, response as unknown as Response);
    expect(response.sendStatus).toHaveBeenCalledWith(200);
  });
});

describe("malformed button taps", () => {
  it.each([["garbage"], ["confirm:"], ["approve:abc"], [""]])("answers %j silently and executes nothing", async (data) => {
    const tool = orderTool();
    createConfirmation("123", "create_position", {}, "CARD", { orderId: "order-1" });
    tap(data);
    await vi.waitFor(() => expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("cb-1"));
    expect(tool.execute).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("answers silently, and executes nothing, when the tap carries no message (so no chat can be verified)", async () => {
    const tool = orderTool();
    const confirmation = createConfirmation("123", "create_position", {}, "CARD", { orderId: "order-1" });
    const response = { sendStatus: vi.fn() };
    const request = {
      get: () => "secret",
      body: { callback_query: { id: "cb-9", data: `confirm:${confirmation.id}` } },
    };
    handleGenosukeWebhook(request as unknown as Request, response as unknown as Response);
    await vi.waitFor(() => expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("cb-9"));
    expect(tool.execute).not.toHaveBeenCalled();
    tap(`confirm:${confirmation.id}`);
    await vi.waitFor(() => expect(tool.execute).toHaveBeenCalledTimes(1));
  });

  it("an expired card is refused with the expiry message and executes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const tool = orderTool();
      const confirmation = createConfirmation("123", "create_position", {}, "CARD", { orderId: "order-1" });
      vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
      tap(`confirm:${confirmation.id}`);
      await vi.waitFor(() => expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("cb-1", "This confirmation expired or was already resolved."));
      expect(tool.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
