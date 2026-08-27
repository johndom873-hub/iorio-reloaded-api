import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("intraday_price_bars", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.string("bar_size").notNullable();
    table.timestamp("bar_time", { useTz: true }).notNullable();
    table.decimal("open_price", 12, 4);
    table.decimal("high_price", 12, 4);
    table.decimal("low_price", 12, 4);
    table.decimal("close_price", 12, 4);
    table.bigInteger("volume");
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["ticker_id", "bar_size", "bar_time"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("intraday_price_bars");
}
