import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("strategy_settings", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("strategy_key").notNullable().unique();
    table.decimal("delta_target_min", 5, 4);
    table.decimal("delta_target_max", 5, 4);
    table.integer("dte_target_min");
    table.integer("dte_target_max");
    table.decimal("max_position_pct_of_portfolio", 5, 2);
    table.decimal("max_aggregate_collateral_pct", 5, 2);
    table.decimal("max_concentration_per_ticker_pct", 5, 2);
    table.decimal("max_concentration_per_sector_pct", 5, 2);
    table.decimal("min_cash_reserve_pct", 5, 2);
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("strategy_settings");
}
