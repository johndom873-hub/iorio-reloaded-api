import type { Knex } from "knex";

// A backtest session measures itself by its wheel cycles and positions, as the platform does (Marcelo 2026-10-12): each
// option sold names its position (with the position's P&L) and its cycle (with the cycle's total), and pnl_basis says
// which a session's stored metrics are on ('option' for the sessions run before: their rows keep the option's own
// result in pnl_dollars). It also keeps a second baseline for comparison, buy and hold of SPY, beside buy and hold of
// its own symbols.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.text("pnl_basis").notNullable().defaultTo("option");
    table.jsonb("spy_baseline_metrics");
  });
  await knex.schema.alterTable("backtest_session_days", (table) => {
    table.decimal("spy_baseline_value", 16, 2);
    table.decimal("spy_baseline_daily_return", 14, 10);
  });
  await knex.schema.alterTable("backtest_trades", (table) => {
    table.text("position_id");
    table.text("position_status");
    table.decimal("position_pnl_dollars", 16, 2);
    table.integer("cycle_number");
    table.text("cycle_status");
    table.decimal("cycle_total_dollars", 16, 2);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_trades", (table) => {
    for (const column of ["position_id", "position_status", "position_pnl_dollars", "cycle_number", "cycle_status", "cycle_total_dollars"]) table.dropColumn(column);
  });
  await knex.schema.alterTable("backtest_session_days", (table) => {
    table.dropColumn("spy_baseline_value");
    table.dropColumn("spy_baseline_daily_return");
  });
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.dropColumn("pnl_basis");
    table.dropColumn("spy_baseline_metrics");
  });
}
