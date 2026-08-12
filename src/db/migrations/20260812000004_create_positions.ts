import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("positions", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("strategy_key").notNullable();
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.enu("status", ["open", "closed"], { useNative: false }).notNullable();
    table.text("ibkr_account_id");
    table.timestamp("opened_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("closed_at", { useTz: true });
    table.text("notes");

    table.index(["strategy_key"]);
    table.index(["status"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("positions");
}
