// DB-backed replacement for bot.ts's old in-memory chatHistories Map — a
// Heroku deploy restarts the web dyno, which used to wipe any in-progress
// conversation. Purge runs inline on every call rather than as a scheduled
// job so the 24h window stays rolling relative to actual usage, not a fixed
// wall-clock sweep (approved 2026-08-27).
import { db } from "../db/connection.js";
import type { ChatMessage, ChatRole, ToolCall } from "./openRouterAdapter.js";

interface ChatMessageRow {
  id: string;
  chat_id: string;
  role: ChatRole;
  content: string | null;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
}

function rowToMessage(row: ChatMessageRow): ChatMessage {
  const message: ChatMessage = { role: row.role, content: row.content };
  if (row.tool_calls) message.toolCalls = row.tool_calls;
  if (row.tool_call_id) message.toolCallId = row.tool_call_id;
  return message;
}

/**
 * Deletes anything outside the rolling 24h window (across all chats — cheap,
 * since this table only ever holds a day's worth of conversation), then
 * returns this chat's remaining history in the exact order it was written.
 */
export async function loadRecentHistory(chatId: string): Promise<ChatMessage[]> {
  await db("genosuke_chat_messages")
    .where("created_at", "<", db.raw("now() - interval '24 hours'"))
    .del();

  const rows = await db<ChatMessageRow>("genosuke_chat_messages").where({ chat_id: chatId }).orderBy("id", "asc");
  return rows.map(rowToMessage);
}

/** Persists whatever chatOnce appended to `messages` since `fromIndex` — i.e. this turn's new entries only. */
export async function appendHistory(chatId: string, messages: ChatMessage[], fromIndex: number): Promise<void> {
  const newMessages = messages.slice(fromIndex);
  if (newMessages.length === 0) return;

  await db("genosuke_chat_messages").insert(
    newMessages.map((message) => ({
      chat_id: chatId,
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      tool_call_id: message.toolCallId ?? null,
    })),
  );
}
