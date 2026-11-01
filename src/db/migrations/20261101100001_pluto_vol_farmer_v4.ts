import type { Knex } from "knex";

// Vol Farmer v4 replaces v2 in Pluto (Marcelo 2026-10-31): the lab's best run (Pool 52 R5) becomes Pluto's Vol Farmer. v2's
// settings, ticker strategy and memory are renamed v4's (a ticker's memory carries over: a ticker whose shares carry an open
// Call waits for it either way); v4's own choices are added at the run's values, which the live values move to as well
// (First position 80%, excess allowance 20%, Calls' |delta| up to 0.5, LEAPS 180 days at |delta| 0.6), each recorded in the
// settings history. Pluto's actions keep 'vol_farmer_v2' allowed: they are its history and stay as they were.

const renamedSettingColumns = ["first_position_pct", "puts_start_call_yield_pct", "put_max_abs_delta", "step_below_first_break_even_pct", "step_rule", "leaps_min_dte", "leaps_abs_delta", "leaps_max_allocation_pct", "call_min_abs_delta", "call_max_abs_delta", "max_spread_pct_of_mid"] as const;

/** v4's own choices: column, default (the best run's) and, for a choice, its values. */
const choiceColumns: { column: string; defaultValue: string; values: readonly string[] }[] = [
  { column: "vol_farmer_v4_rebalances", defaultValue: "both_positions", values: ["first_position", "both_positions"] },
  { column: "vol_farmer_v4_first_position_after_called_away", defaultValue: "wait", values: ["wait", "rebuild"] },
  { column: "vol_farmer_v4_options_expiry", defaultValue: "today", values: ["next", "today"] },
  { column: "vol_farmer_v4_call_strike_floor", defaultValue: "none", values: ["break_even", "none"] },
  { column: "vol_farmer_v4_puts_sold", defaultValue: "calls_yield_little", values: ["calls_yield_little", "with_every_call"] },
  { column: "vol_farmer_v4_put_strike_cap", defaultValue: "first_break_even_less_step", values: ["first_break_even_less_step", "none"] },
  { column: "vol_farmer_v4_trims_sell", defaultValue: "higher_break_even_first", values: ["higher_break_even_first", "second_position_first"] },
];

/** The live values moved to the best run's: settings key (as the history records it), column, value. */
const bestRunValues: { field: string; column: string; value: number }[] = [
  { field: "volFarmerV4FirstPositionPct", column: "vol_farmer_v4_first_position_pct", value: 80 },
  { field: "excessAllowancePct", column: "excess_allowance_pct", value: 20 },
  { field: "volFarmerV4CallMaxAbsDelta", column: "vol_farmer_v4_call_max_abs_delta", value: 0.5 },
  { field: "volFarmerV4LeapsMinDte", column: "vol_farmer_v4_leaps_min_dte", value: 180 },
  { field: "volFarmerV4LeapsAbsDelta", column: "vol_farmer_v4_leaps_abs_delta", value: 0.6 },
];

export async function up(knex: Knex): Promise<void> {
  await knex.raw("alter table pluto_actions drop constraint pluto_actions_execution_strategy_check");
  await knex.raw("alter table pluto_actions add constraint pluto_actions_execution_strategy_check check (execution_strategy in ('edge_margin', 'cc_put_ladder', 'vol_farmer_v2', 'vol_farmer_v4'))");

  await knex.raw("alter table pluto_ticker_settings drop constraint pluto_ticker_settings_strategy_check");
  await knex("pluto_ticker_settings").where({ strategy: "vol_farmer_v2" }).update({ strategy: "vol_farmer_v4" });
  await knex.raw("alter table pluto_ticker_settings add constraint pluto_ticker_settings_strategy_check check (strategy is null or strategy in ('vol_farmer_v4', 'cc_put_ladder'))");

  await knex.raw("alter table pluto_settings drop constraint pluto_settings_vol_farmer_v2_step_rule_check");
  for (const column of renamedSettingColumns) await knex.raw(`alter table pluto_settings rename column vol_farmer_v2_${column} to vol_farmer_v4_${column}`);
  await knex.raw("alter table pluto_settings add constraint pluto_settings_vol_farmer_v4_step_rule_check check (vol_farmer_v4_step_rule in ('fixed', 'implied_move_at_put_sale'))");
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("vol_farmer_v4_first_position_pct", 8, 4).notNullable().defaultTo(80).alter();
    table.decimal("vol_farmer_v4_call_max_abs_delta", 6, 4).notNullable().defaultTo(0.5).alter();
    table.integer("vol_farmer_v4_leaps_min_dte").notNullable().defaultTo(180).alter();
    table.decimal("vol_farmer_v4_leaps_abs_delta", 6, 4).notNullable().defaultTo(0.6).alter();
    table.decimal("excess_allowance_pct", 8, 4).notNullable().defaultTo(20).alter();
    table.decimal("vol_farmer_v4_rebalance_band_pct", 8, 4).notNullable().defaultTo(5);
    table.integer("vol_farmer_v4_options_max_days_to_expiry").notNullable().defaultTo(45);
    for (const choice of choiceColumns) table.text(choice.column).notNullable().defaultTo(choice.defaultValue);
  });
  for (const choice of choiceColumns) await knex.raw(`alter table pluto_settings add constraint pluto_settings_${choice.column}_check check (${choice.column} in (${choice.values.map((value) => `'${value}'`).join(", ")}))`);

  const before = await knex("pluto_settings").where({ id: 1 }).first(bestRunValues.map((entry) => entry.column));
  if (before) {
    const changed = bestRunValues.filter((entry) => Number(before[entry.column]) !== entry.value);
    if (changed.length > 0) {
      await knex("pluto_settings").where({ id: 1 }).update({ ...Object.fromEntries(changed.map((entry) => [entry.column, entry.value])), updated_at: knex.fn.now(), updated_by_user_id: null });
      await knex("pluto_settings_audit").insert(changed.map((entry) => ({ user_id: null, field: entry.field, old_value: String(Number(before[entry.column])), new_value: String(entry.value) })));
    }
  }

  await knex.schema.renameTable("pluto_vol_farmer_v2_cycles", "pluto_vol_farmer_v4_cycles");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.renameTable("pluto_vol_farmer_v4_cycles", "pluto_vol_farmer_v2_cycles");
  for (const choice of choiceColumns) await knex.raw(`alter table pluto_settings drop constraint pluto_settings_${choice.column}_check`);
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.dropColumns("vol_farmer_v4_rebalance_band_pct", "vol_farmer_v4_options_max_days_to_expiry", ...choiceColumns.map((choice) => choice.column));
    table.decimal("vol_farmer_v4_first_position_pct", 8, 4).notNullable().defaultTo(50).alter();
    table.decimal("vol_farmer_v4_call_max_abs_delta", 6, 4).notNullable().defaultTo(0.3).alter();
    table.integer("vol_farmer_v4_leaps_min_dte").notNullable().defaultTo(365).alter();
    table.decimal("vol_farmer_v4_leaps_abs_delta", 6, 4).notNullable().defaultTo(0.7).alter();
    table.decimal("excess_allowance_pct", 8, 4).notNullable().defaultTo(0).alter();
  });
  await knex.raw("alter table pluto_settings drop constraint pluto_settings_vol_farmer_v4_step_rule_check");
  for (const column of renamedSettingColumns) await knex.raw(`alter table pluto_settings rename column vol_farmer_v4_${column} to vol_farmer_v2_${column}`);
  await knex.raw("alter table pluto_settings add constraint pluto_settings_vol_farmer_v2_step_rule_check check (vol_farmer_v2_step_rule in ('fixed', 'implied_move_at_put_sale'))");

  await knex.raw("alter table pluto_ticker_settings drop constraint pluto_ticker_settings_strategy_check");
  await knex("pluto_ticker_settings").where({ strategy: "vol_farmer_v4" }).update({ strategy: "vol_farmer_v2" });
  await knex.raw("alter table pluto_ticker_settings add constraint pluto_ticker_settings_strategy_check check (strategy is null or strategy in ('vol_farmer_v2', 'cc_put_ladder'))");
  // pluto_actions keeps 'vol_farmer_v4' allowed: rows written under it are Pluto's history.
}
