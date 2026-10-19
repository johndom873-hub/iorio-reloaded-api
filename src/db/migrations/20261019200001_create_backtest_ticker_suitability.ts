import type { Knex } from "knex";

// Whether a downloaded ticker suits the CC + Put Ladder, with a note (Marcelo 2026-10-19): marked from the Data files
// table by an admin. No row: Pending; a "pending" row is a Pending ticker with a note (written outside the window, which
// only marks Suitable or Unsuitable). Kept when the data file is deleted, so a ticker downloaded again shows its note.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_ticker_suitability", (table) => {
    table.text("symbol").primary();
    table.text("status").notNullable();
    table.text("note").notNullable().defaultTo("");
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("updated_by_user_id").references("id").inTable("users").onDelete("SET NULL");
  });
  await knex.raw("ALTER TABLE backtest_ticker_suitability ADD CONSTRAINT backtest_ticker_suitability_status_check CHECK (status IN ('pending', 'suitable', 'unsuitable'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_ticker_suitability");
}
