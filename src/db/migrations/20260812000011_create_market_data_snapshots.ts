import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("market_data_snapshots", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.date("snapshot_date").notNullable();
    table.decimal("implied_volatility", 8, 6);
    table.decimal("avg_option_volume", 14, 2);
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["ticker_id", "snapshot_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("market_data_snapshots");
}
