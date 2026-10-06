import type { Knex } from "knex";

// Telegram verbosity is "actions" or "off" (Marcelo, 2026-10-06): "all" never sent anything extra, and every decision is
// already on the Pluto screen. A row still holding "all" becomes "actions", which is what it behaved as.
export async function up(knex: Knex): Promise<void> {
  await knex("pluto_settings").where({ telegram_verbosity: "all" }).update({ telegram_verbosity: "actions" });
}

export async function down(): Promise<void> {
  // Nothing to restore: "all" behaved exactly like "actions".
}
