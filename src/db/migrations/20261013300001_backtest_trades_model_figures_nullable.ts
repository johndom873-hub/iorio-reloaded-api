import type { Knex } from "knex";

// A baseline wheel session (decision maker "baseline", Marcelo 2026-10-13) sells options without the Signals model, so its
// trades carry no grade, edge margin or Edge $: those columns take null.
const modelColumns = ["grade", "edge_margin", "expected_pnl_dollars", "calibrated_expected_pnl_dollars"] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_trades", (table) => {
    for (const column of modelColumns) table.setNullable(column);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Baseline trades cannot keep their rows under the old constraint: their sessions are removed first.
  await knex("backtest_sessions").whereIn("id", knex("backtest_trades").whereNull("grade").select("session_id")).delete();
  await knex.schema.alterTable("backtest_trades", (table) => {
    for (const column of modelColumns) table.dropNullable(column);
  });
}
