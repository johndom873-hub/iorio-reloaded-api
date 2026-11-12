import type { Knex } from "knex";

// An option fill's stock price, from the same snapshot as its bid and ask (IBKR's option computation tick), for the Wheel
// cycle's Stock price on option rows (Marcelo 2026-11-11). Null for a stock fill, a fill from before, or none sent.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("execution_quotes", (table) => {
    table.decimal("underlying_price", 12, 4);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("execution_quotes", (table) => {
    table.dropColumn("underlying_price");
  });
}
