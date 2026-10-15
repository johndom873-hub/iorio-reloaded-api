import type { Knex } from "knex";

// Pluto's execution strategies (Marcelo 2026-10-15): one active at a time, "edge_margin" (the model-driven Pluto) or
// "cc_put_ladder" (the backtested CC + Put Ladder, rules only). The ladder's strategy-wide values are typed columns on
// pluto_settings (validated, audited and versioned per pass like every Pluto setting); defaults are the adopted values.
// Per-ticker overrides live in pluto_ticker_settings, keyed by ticker so they survive a ticker leaving and rejoining
// the shortlist; null means "use the default".
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.text("execution_strategy").notNullable().defaultTo("edge_margin");
    table.decimal("ladder_min_abs_delta", 6, 4).notNullable().defaultTo(0.05);
    table.decimal("ladder_max_abs_delta", 6, 4).notNullable().defaultTo(0.3);
    table.integer("ladder_min_dte").notNullable().defaultTo(1);
    table.integer("ladder_max_dte").notNullable().defaultTo(45);
    table.decimal("ladder_max_spread_pct_of_mid", 6, 2).notNullable().defaultTo(50);
    table.integer("ladder_rungs").notNullable().defaultTo(5);
    table.decimal("ladder_shares_pct", 6, 2).notNullable().defaultTo(50);
    table.decimal("ladder_shock_min_pct", 6, 2).notNullable().defaultTo(60);
    table.decimal("ladder_shock_max_pct", 6, 2).notNullable().defaultTo(80);
    table.decimal("ladder_shock_no_history_pct", 6, 2).notNullable().defaultTo(90);
    table.integer("ladder_shock_lookback_years").notNullable().defaultTo(10);
    table.integer("ladder_max_working_orders_per_ticker").notNullable().defaultTo(5);
  });
  await knex.raw("alter table pluto_settings add constraint pluto_settings_execution_strategy_check check (execution_strategy in ('edge_margin', 'cc_put_ladder'))");

  await knex.schema.createTable("pluto_ticker_settings", (table) => {
    table.uuid("ticker_id").primary().references("id").inTable("tickers").onDelete("CASCADE");
    table.decimal("allocation_pct", 6, 2).nullable();
    table.decimal("ladder_shares_pct", 6, 2).nullable();
    table.decimal("ladder_shock_override_pct", 6, 2).nullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("updated_by_user_id").references("id").inTable("users").onDelete("SET NULL");
  });

  await knex.schema.createTable("pluto_ticker_settings_audit", (table) => {
    table.bigIncrements("id");
    table.timestamp("changed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers").onDelete("CASCADE");
    table.uuid("user_id").references("id").inTable("users").onDelete("SET NULL");
    table.text("field").notNullable();
    table.text("old_value");
    table.text("new_value");
    table.index(["ticker_id", "changed_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("pluto_ticker_settings_audit");
  await knex.schema.dropTable("pluto_ticker_settings");
  await knex.raw("alter table pluto_settings drop constraint pluto_settings_execution_strategy_check");
  await knex.schema.alterTable("pluto_settings", (table) => {
    for (const column of [
      "execution_strategy", "ladder_min_abs_delta", "ladder_max_abs_delta", "ladder_min_dte", "ladder_max_dte", "ladder_max_spread_pct_of_mid", "ladder_rungs",
      "ladder_shares_pct", "ladder_shock_min_pct", "ladder_shock_max_pct", "ladder_shock_no_history_pct", "ladder_shock_lookback_years", "ladder_max_working_orders_per_ticker",
    ]) table.dropColumn(column);
  });
}
