import type { Knex } from "knex";

// Pluto follows Day Signals in a continuous loop (Marcelo, 2026-10-06): the 20 s coalescing window and the
// spot-move trigger go (a price move is an input to the analysis, never a trigger), and a poll interval for the
// Day Signals table comes in. Sizing is one standard order size, a share of Pluto's own capital budget instead of
// a ceiling on the whole account. Defaults approved the same day for the $1M paper account: budget 50 %, order size
// 10 % of the budget, 15 open positions. Pluto has not been deployed anywhere, so the single settings row takes the
// new defaults too.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("spot_move_trigger_pct");
    table.dropColumn("coalescing_window_seconds");
    table.renameColumn("max_order_notional_pct", "order_size_pct_of_budget");
    table.integer("day_signals_poll_seconds").notNullable().defaultTo(1);
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("capital_budget_pct", 6, 2).notNullable().defaultTo(50).alter();
    table.decimal("order_size_pct_of_budget", 6, 2).notNullable().defaultTo(10).alter();
    table.integer("max_open_positions").notNullable().defaultTo(15).alter();
    // One model call per decision under a $1/day ceiling (Marcelo, 2026-10-06): 20 calls at ~$0.05.
    table.decimal("daily_cost_ceiling_usd", 8, 2).notNullable().defaultTo(1).alter();
    table.integer("max_model_calls_per_session").notNullable().defaultTo(20).alter();
    table.text("prompt_version").notNullable().defaultTo("v3").alter();
  });
  await knex("pluto_settings").update({ capital_budget_pct: 50, order_size_pct_of_budget: 10, max_open_positions: 15, daily_cost_ceiling_usd: 1, max_model_calls_per_session: 20, prompt_version: "v3" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("capital_budget_pct", 6, 2).notNullable().defaultTo(30).alter();
    table.decimal("order_size_pct_of_budget", 6, 2).notNullable().defaultTo(10).alter();
    table.integer("max_open_positions").notNullable().defaultTo(8).alter();
    table.decimal("daily_cost_ceiling_usd", 8, 2).notNullable().defaultTo(3).alter();
    table.integer("max_model_calls_per_session").notNullable().defaultTo(12).alter();
    table.text("prompt_version").notNullable().defaultTo("v2").alter();
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumn("day_signals_poll_seconds");
    table.renameColumn("order_size_pct_of_budget", "max_order_notional_pct");
    table.decimal("spot_move_trigger_pct", 6, 2).notNullable().defaultTo(1.5);
    table.integer("coalescing_window_seconds").notNullable().defaultTo(20);
  });
}
