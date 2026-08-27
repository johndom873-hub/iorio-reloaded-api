import type { Knex } from "knex";

// Replaces bot.ts's old in-memory chatHistories Map so a Heroku dyno
// restart (which happens on every deploy) doesn't wipe an in-progress
// conversation. Purge is inline in chatHistoryStore.ts on every message
// (delete anything older than 24h, then read) rather than a scheduled job —
// approved 2026-08-27 specifically so the 24h window stays rolling relative
// to actual usage instead of a fixed wall-clock sweep.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("genosuke_chat_messages", (table) => {
    table.bigIncrements("id", { primaryKey: true });
    // Not a real Telegram chat id FK — just the chat_id string it always was
    // as a Map key, kept a plain column so a chat existing/not existing
    // elsewhere never blocks writing here.
    table.text("chat_id").notNullable();
    table.text("role").notNullable();
    table.text("content");
    // toolCalls (assistant turns that call a tool) and toolCallId (the
    // matching tool-result turn) — both needed verbatim to replay a
    // multi-turn tool exchange back to the LLM in the exact shape it expects.
    table.jsonb("tool_calls");
    table.text("tool_call_id");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Ordered read-back per chat; id (insertion order), not created_at, is
    // the sort key — see chatHistoryStore.ts for why.
    table.index(["chat_id", "id"]);
    table.index(["created_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("genosuke_chat_messages");
}
