import type { Knex } from "knex";

// The screener is no longer scoped per-strategy — a shortlisted ticker is
// scanned by every strategy's trade-alert job. See PROGRESS.md.
export async function up(knex: Knex): Promise<void> {
  await knex.raw("DROP INDEX IF EXISTS shortlist_entries_active_ticker_strategy_idx");
  await knex.schema.alterTable("shortlist_entries", (table) => {
    table.dropColumn("strategy_key");
  });
  await knex.raw(`
    CREATE UNIQUE INDEX shortlist_entries_active_ticker_idx
    ON shortlist_entries (ticker_id)
    WHERE removed_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP INDEX IF EXISTS shortlist_entries_active_ticker_idx");
  await knex.schema.alterTable("shortlist_entries", (table) => {
    table.text("strategy_key").notNullable().defaultTo("covered_call");
  });
  await knex.raw("ALTER TABLE shortlist_entries ALTER COLUMN strategy_key DROP DEFAULT");
  await knex.raw(`
    CREATE UNIQUE INDEX shortlist_entries_active_ticker_strategy_idx
    ON shortlist_entries (ticker_id, strategy_key)
    WHERE removed_at IS NULL
  `);
}
