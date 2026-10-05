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

const { startGenosuke, handleGenosukeWebhook } = await import("./bot.js");
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
