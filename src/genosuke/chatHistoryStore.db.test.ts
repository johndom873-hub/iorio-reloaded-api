import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";
import type { ChatMessage } from "./openRouterAdapter.js";

// The chat history store against the test database's genosuke_chat_messages table. Every chat id is unique to this run
// and only those rows are removed afterwards. (loadRecentHistory itself purges rows older than 24h in every chat: that is the behaviour under test.)
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run chat history database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { appendHistory, loadRecentHistory } = await import("./chatHistoryStore.js");

const testDb: Knex = db;
const stamp = Date.now();
const chatIds: string[] = [];
let chatCounter = 0;
const newChatId = () => {
  const chatId = `history-test-${stamp}-${(chatCounter += 1)}`;
  chatIds.push(chatId);
  return chatId;
};

afterAll(async () => {
  await testDb("genosuke_chat_messages").whereIn("chat_id", chatIds).del();
  await testDb.destroy();
});

describe("appendHistory and loadRecentHistory", () => {
  it("returns nothing for a chat with no history", async () => {
    expect(await loadRecentHistory(newChatId())).toEqual([]);
  });

  it("round-trips user, assistant-with-tool-calls and tool messages in the order they were written", async () => {
    const chatId = newChatId();
    const messages: ChatMessage[] = [
      { role: "user", content: "close my AAOI put" },
      { role: "assistant", content: null, toolCalls: [{ id: "call-1", name: "list_positions", input: { status: "open" } }] },
      { role: "tool", content: '[{"id":"p1"}]', toolCallId: "call-1" },
      { role: "assistant", content: "Found it." },
    ];
    await appendHistory(chatId, messages, 0);
    expect(await loadRecentHistory(chatId)).toEqual(messages);
  });

  it("keeps the original order across several appends", async () => {
    const chatId = newChatId();
    await appendHistory(chatId, [{ role: "user", content: "one" }], 0);
    await appendHistory(chatId, [{ role: "assistant", content: "two" }], 0);
    await appendHistory(chatId, [{ role: "user", content: "three" }, { role: "assistant", content: "four" }], 0);
    expect((await loadRecentHistory(chatId)).map((message) => message.content)).toEqual(["one", "two", "three", "four"]);
  });

  it("persists only the messages from fromIndex onward", async () => {
    const chatId = newChatId();
    const messages: ChatMessage[] = [{ role: "user", content: "already stored" }, { role: "user", content: "new" }, { role: "assistant", content: "reply" }];
    await appendHistory(chatId, messages, 1);
    expect((await loadRecentHistory(chatId)).map((message) => message.content)).toEqual(["new", "reply"]);
  });

  it("writes nothing when there is nothing new", async () => {
    const chatId = newChatId();
    await appendHistory(chatId, [{ role: "user", content: "x" }], 1);
    await appendHistory(chatId, [], 0);
    expect(await loadRecentHistory(chatId)).toEqual([]);
  });

  it("keeps each chat's history separate", async () => {
    const chatA = newChatId();
    const chatB = newChatId();
    await appendHistory(chatA, [{ role: "user", content: "for A" }], 0);
    await appendHistory(chatB, [{ role: "user", content: "for B" }], 0);
    expect((await loadRecentHistory(chatA)).map((message) => message.content)).toEqual(["for A"]);
    expect((await loadRecentHistory(chatB)).map((message) => message.content)).toEqual(["for B"]);
  });

  it("omits toolCalls and toolCallId from messages that have none", async () => {
    const chatId = newChatId();
    await appendHistory(chatId, [{ role: "user", content: "plain" }], 0);
    const [message] = await loadRecentHistory(chatId);
    expect(Object.keys(message!).sort()).toEqual(["content", "role"]);
  });

  it("stores a null content as null", async () => {
    const chatId = newChatId();
    await appendHistory(chatId, [{ role: "assistant", content: null, toolCalls: [{ id: "c", name: "t", input: {} }] }], 0);
    expect((await loadRecentHistory(chatId))[0]!.content).toBeNull();
  });

  it("forgets messages older than 24 hours and keeps recent ones", async () => {
    const chatId = newChatId();
    await testDb("genosuke_chat_messages").insert([
      { chat_id: chatId, role: "user", content: "stale", created_at: testDb.raw("now() - interval '25 hours'") },
      { chat_id: chatId, role: "user", content: "recent", created_at: testDb.raw("now() - interval '23 hours'") },
    ]);
    expect((await loadRecentHistory(chatId)).map((message) => message.content)).toEqual(["recent"]);
    const remaining = await testDb("genosuke_chat_messages").where({ chat_id: chatId }).select("content");
    expect(remaining.map((row) => row.content)).toEqual(["recent"]);
  });
});
