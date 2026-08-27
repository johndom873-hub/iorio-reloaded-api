import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tickers", (table) => {
    table.integer("ibkr_contract_id");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tickers", (table) => {
    table.dropColumn("ibkr_contract_id");
  });
}
