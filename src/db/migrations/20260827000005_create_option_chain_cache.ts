import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("option_chain_params", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().unique().references("id").inTable("tickers");
    table.specificType("expirations", "text[]").notNullable();
    table.specificType("strikes", "decimal(12,4)[]").notNullable();
    table.timestamp("fetched_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("option_chain_strike_checks", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.string("expiry").notNullable();
    table.decimal("strike", 12, 4).notNullable();
    table.boolean("exists").notNullable();
    table.timestamp("checked_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["ticker_id", "expiry", "strike"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("option_chain_strike_checks");
  await knex.schema.dropTableIfExists("option_chain_params");
}
