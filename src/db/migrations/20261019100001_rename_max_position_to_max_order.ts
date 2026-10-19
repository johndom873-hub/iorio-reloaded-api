import type { Knex } from "knex";

// "Max position size %" is checked per order, not per position or ticker, so it is renamed "Max order size %" everywhere
// (Marcelo 2026-10-17): the trading_settings column, and the same names stored inside JSON (old orders' limit checks, backtest
// settings snapshots and overrides, lab settings, ticker analyses' lab values) and in the Risk & Limits change history.
//   max_position_pct_of_portfolio  -> max_order_pct_of_portfolio
//   "maxPositionPctOfPortfolio"    -> "maxOrderPctOfPortfolio"
//   "positionSharePct"             -> "orderSharePct"

const jsonColumns: { table: string; column: string }[] = [
  { table: "order_requests", column: "gate_evaluation" },
  { table: "backtest_sessions", column: "settings_snapshot" },
  { table: "backtest_sessions", column: "overrides" },
  { table: "backtest_lab_settings", column: "settings" },
  { table: "backtest_ticker_analyses", column: "lab_values" },
];

const keyRenames: [from: string, to: string][] = [
  ["maxPositionPctOfPortfolio", "maxOrderPctOfPortfolio"],
  ["positionSharePct", "orderSharePct"],
];

/** Renames JSON object keys by their quoted text: the names are distinctive enough never to appear as a string value. */
async function renameJsonKeys(knex: Knex, renames: [string, string][]): Promise<void> {
  for (const { table, column } of jsonColumns) {
    for (const [from, to] of renames) {
      await knex.raw(`UPDATE ?? SET ?? = replace(??::text, ?, ?)::jsonb WHERE ??::text LIKE ?`, [table, column, column, `"${from}"`, `"${to}"`, column, `%"${from}"%`]);
    }
  }
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trading_settings", (table) => {
    table.renameColumn("max_position_pct_of_portfolio", "max_order_pct_of_portfolio");
  });
  await renameJsonKeys(knex, keyRenames);
  await knex("risk_limits_audit").where({ field: "maxPositionPctOfPortfolio" }).update({ field: "maxOrderPctOfPortfolio" });
}

export async function down(knex: Knex): Promise<void> {
  await knex("risk_limits_audit").where({ field: "maxOrderPctOfPortfolio" }).update({ field: "maxPositionPctOfPortfolio" });
  await renameJsonKeys(knex, keyRenames.map(([from, to]) => [to, from]));
  await knex.schema.alterTable("trading_settings", (table) => {
    table.renameColumn("max_order_pct_of_portfolio", "max_position_pct_of_portfolio");
  });
}
