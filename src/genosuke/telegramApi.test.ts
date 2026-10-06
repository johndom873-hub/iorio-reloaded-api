import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramApi } from "./telegramApi.js";

const api = new TelegramApi("123:TOKEN");
const baseUrl = "https://api.telegram.org/bot123:TOKEN";
let fetchMock: ReturnType<typeof vi.fn>;

const sentBody = (callIndex = 0) => JSON.parse(fetchMock.mock.calls[callIndex]![1].body as string);

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getMe", () => {
  it("returns the bot's id and username", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { id: 42, username: "genosuke_bot" } })));
    expect(await api.getMe()).toEqual({ id: 42, username: "genosuke_bot" });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/getMe`);
  });

  it("rejects when the body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(api.getMe()).rejects.toThrow(SyntaxError);
  });
});

describe("setWebhook", () => {
  it("registers the url and secret and asks only for messages and callback queries", async () => {
    await api.setWebhook("https://example.test/genosuke/webhook", "s3cret");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/setWebhook`);
    expect(init.method).toBe("POST");
    expect(sentBody()).toEqual({ url: "https://example.test/genosuke/webhook", secret_token: "s3cret", allowed_updates: ["message", "callback_query"] });
  });

  it("throws with the status and body when Telegram refuses", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(api.setWebhook("https://x", "s")).rejects.toThrow("setWebhook failed (401): Unauthorized");
  });
});

describe("sendMessage", () => {
  it("sends a plain message with link previews off", async () => {
    await api.sendMessage("chat-1", "hello");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/sendMessage`);
    expect(sentBody()).toEqual({ chat_id: "chat-1", text: "hello", disable_web_page_preview: true });
  });

  it("replies to a message and still sends if that message is gone", async () => {
    await api.sendMessage("chat-1", "hi", { replyToMessageId: 55 });
    expect(sentBody()).toMatchObject({ reply_to_message_id: 55, allow_sending_without_reply: true });
  });

  it("does not add reply fields when the reply id is absent", async () => {
    await api.sendMessage("chat-1", "hi", {});
    expect("reply_to_message_id" in sentBody()).toBe(false);
  });

  it("attaches inline buttons as an inline keyboard", async () => {
    const buttons = [[{ text: "Yes", callback_data: "confirm:abc" }, { text: "Cancel", callback_data: "cancel:abc" }]];
    await api.sendMessage("chat-1", "Confirm:\ncard", { buttons });
    expect(sentBody().reply_markup).toEqual({ inline_keyboard: buttons });
  });

  it("leaves a message at the 4096 character limit untouched", async () => {
    await api.sendMessage("chat-1", "a".repeat(4096));
    expect(sentBody().text).toBe("a".repeat(4096));
  });

  it("truncates a longer message to exactly 4096 characters ending with the truncation notice", async () => {
    await api.sendMessage("chat-1", "a".repeat(5000));
    const text = sentBody().text as string;
    expect(text).toHaveLength(4096);
    expect(text.endsWith("... (message truncated)")).toBe(true);
    expect(text.startsWith("a".repeat(100))).toBe(true);
  });

  it("warns, rather than throwing, when Telegram answers an error status", async () => {
    fetchMock.mockResolvedValue(new Response("Bad Request: chat not found", { status: 400 }));
    await expect(api.sendMessage("chat-1", "hi")).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith("Genosuke: sendMessage failed (400): Bad Request: chat not found");
  });

  it("warns, rather than throwing, when the request itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(api.sendMessage("chat-1", "hi")).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith("Genosuke: sendMessage failed", "ECONNRESET");
  });

  it("warns with the raw value when a non-Error is thrown", async () => {
    fetchMock.mockRejectedValue("boom");
    await api.sendMessage("chat-1", "hi");
    expect(console.warn).toHaveBeenCalledWith("Genosuke: sendMessage failed", "boom");
  });
});

describe("clearInlineKeyboard", () => {
  it("edits the message's reply markup to an empty keyboard", async () => {
    await api.clearInlineKeyboard("chat-1", 9);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/editMessageReplyMarkup`);
    expect(sentBody()).toEqual({ chat_id: "chat-1", message_id: 9, reply_markup: { inline_keyboard: [] } });
  });

  it("swallows a failure", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(api.clearInlineKeyboard("chat-1", 9)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith("Genosuke: clearInlineKeyboard failed", "network down");
  });
});

describe("answerCallbackQuery", () => {
  it("answers with the text when given", async () => {
    await api.answerCallbackQuery("cb-1", "Confirmed.");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/answerCallbackQuery`);
    expect(sentBody()).toEqual({ callback_query_id: "cb-1", text: "Confirmed." });
  });

  it("answers without text for a silent dismissal", async () => {
    await api.answerCallbackQuery("cb-2");
    expect(sentBody()).toEqual({ callback_query_id: "cb-2" });
  });

  it("swallows a failure", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(api.answerCallbackQuery("cb-3")).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith("Genosuke: answerCallbackQuery failed", "network down");
  });
});
