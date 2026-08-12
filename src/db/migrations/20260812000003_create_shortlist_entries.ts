import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("shortlist_entries", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.text("strategy_key").notNullable();
    table.uuid("added_by_user_id").notNullable().references("id").inTable("users");
    table.timestamp("added_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("removed_at", { useTz: true });
    table.text("notes");
  });

  // Partial unique index: a ticker can only be actively shortlisted once per
  // strategy, but can be re-added after removal (removed_at soft-delete).
  await knex.raw(`
    CREATE UNIQUE INDEX shortlist_entries_active_ticker_strategy_idx
    ON shortlist_entries (ticker_id, strategy_key)
    WHERE removed_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("shortlist_entries");
}
