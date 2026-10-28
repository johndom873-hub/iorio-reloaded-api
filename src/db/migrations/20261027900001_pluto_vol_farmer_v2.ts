import type { Knex } from "knex";

// Vol Farmer v2 in Pluto (Marcelo 2026-10-27): each ticker runs a strategy of its own, Vol Farmer v2 by default
// (pluto_ticker_settings.strategy, null = the default); v2's live settings, global, set once from the lab's values of
// 2026-10-27 (they never sync after); and v2's memory per ticker between looks (pluto_vol_farmer_v2_cycles: the two
// positions, the LEAPS and the orders not yet settled, as volFarmerV2Steps.ts keeps them).
export async function up(knex: Knex): Promise<void> {
  await knex.raw("alter table pluto_actions drop constraint pluto_actions_execution_strategy_check");
  await knex.raw("alter table pluto_actions add constraint pluto_actions_execution_strategy_check check (execution_strategy in ('edge_margin', 'cc_put_ladder', 'vol_farmer_v2'))");

  await knex.schema.alterTable("pluto_ticker_settings", (table) => {
    /** The strategy Pluto runs on the ticker; null = the default, Vol Farmer v2. */
    table.text("strategy").nullable();
  });
  await knex.raw("alter table pluto_ticker_settings add constraint pluto_ticker_settings_strategy_check check (strategy is null or strategy in ('vol_farmer_v2', 'cc_put_ladder'))");

  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("vol_farmer_v2_puts_start_call_yield_pct", 8, 4).notNullable().defaultTo(5);
    table.decimal("vol_farmer_v2_put_max_abs_delta", 6, 4).notNullable().defaultTo(0.3);
    table.decimal("vol_farmer_v2_step_below_first_break_even_pct", 8, 4).notNullable().defaultTo(15);
    table.text("vol_farmer_v2_step_rule").notNullable().defaultTo("implied_move_at_put_sale");
    table.integer("vol_farmer_v2_leaps_min_dte").notNullable().defaultTo(365);
    table.decimal("vol_farmer_v2_leaps_abs_delta", 6, 4).notNullable().defaultTo(0.7);
    /** % of the ticker's allocation a LEAPS purchase spends at most (the lab's leapsMaxAccountPct). */
    table.decimal("vol_farmer_v2_leaps_max_allocation_pct", 8, 4).notNullable().defaultTo(10);
    table.decimal("vol_farmer_v2_call_min_abs_delta", 6, 4).notNullable().defaultTo(0.05);
    table.decimal("vol_farmer_v2_call_max_abs_delta", 6, 4).notNullable().defaultTo(0.3);
    table.decimal("vol_farmer_v2_max_spread_pct_of_mid", 8, 4).notNullable().defaultTo(50);
  });
  await knex.raw("alter table pluto_settings add constraint pluto_settings_vol_farmer_v2_step_rule_check check (vol_farmer_v2_step_rule in ('fixed', 'implied_move_at_put_sale'))");

  await knex.schema.createTable("pluto_vol_farmer_v2_cycles", (table) => {
    table.uuid("ticker_id").primary().references("id").inTable("tickers").onDelete("CASCADE");
    /** The steps' state (VolFarmerV2SymbolState) with the orders not yet settled (PlutoVolFarmerV2Memory). */
    table.jsonb("memory").notNullable();
    /** When the ticker's holdings at the switch were adopted as the first position; null for a cycle v2 opened. */
    table.timestamp("adopted_at", { useTz: true }).nullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("pluto_vol_farmer_v2_cycles");
  await knex.raw("alter table pluto_settings drop constraint pluto_settings_vol_farmer_v2_step_rule_check");
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumns(
      "vol_farmer_v2_puts_start_call_yield_pct",
      "vol_farmer_v2_put_max_abs_delta",
      "vol_farmer_v2_step_below_first_break_even_pct",
      "vol_farmer_v2_step_rule",
      "vol_farmer_v2_leaps_min_dte",
      "vol_farmer_v2_leaps_abs_delta",
      "vol_farmer_v2_leaps_max_allocation_pct",
      "vol_farmer_v2_call_min_abs_delta",
      "vol_farmer_v2_call_max_abs_delta",
      "vol_farmer_v2_max_spread_pct_of_mid",
    );
  });
  await knex.raw("alter table pluto_ticker_settings drop constraint pluto_ticker_settings_strategy_check");
  await knex.schema.alterTable("pluto_ticker_settings", (table) => {
    table.dropColumn("strategy");
  });
  // pluto_actions keeps 'vol_farmer_v2' allowed: its rows are Pluto's history and stay as they were.
}
