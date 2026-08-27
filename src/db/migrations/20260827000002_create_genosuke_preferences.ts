import type { Knex } from "knex";

// Long-term, global (not per-user — see bot.ts's chat-level-only auth model)
// standing instructions Marce or Juan explicitly asked Genosuke to remember,
// e.g. "ask me before rolling short-dated puts". Written/removed only via
// the save_preference/forget_preference tools, after the human has
// explicitly said yes — see chat.ts's SYSTEM_PROMPT. Small table by design:
// every row gets loaded into the system prompt on every call, no retrieval
// or ranking.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("genosuke_preferences", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("content").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("genosuke_preferences");
}
