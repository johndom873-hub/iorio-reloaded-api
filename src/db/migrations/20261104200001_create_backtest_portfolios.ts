import type { Knex } from "knex";

// The portfolio simulator's saved portfolios (Marcelo 2026-11-04): a named book of tickers, their allocations (null: an
// equal share of what the set ones leave) and its account. Names are unique whatever their case.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_portfolios", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("name").notNullable();
    table.jsonb("tickers").notNullable();
    table.decimal("account_dollars", 16, 2).notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw("CREATE UNIQUE INDEX backtest_portfolios_name_unique ON backtest_portfolios (lower(name))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_portfolios");
}
