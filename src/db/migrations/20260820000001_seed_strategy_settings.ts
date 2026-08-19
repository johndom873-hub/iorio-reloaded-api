import type { Knex } from "knex";

// Threshold values approved by the user 2026-08-19 — see PROGRESS.md "Open
// decisions" (strategy risk/sizing settings) for the sign-off requirement,
// and the Risk & Limits screen plan for the cross-checked practitioner
// sources these were drawn from (Schwab education materials, CBOE BXM/PUT
// systematic index rules, common retail options-income playbooks).
const seedRows = [
  {
    strategy_key: "covered_call",
    delta_target_min: 0.2,
    delta_target_max: 0.3,
    dte_target_min: 30,
    dte_target_max: 45,
    max_position_pct_of_portfolio: 10,
    max_aggregate_collateral_pct: 80,
    max_concentration_per_ticker_pct: 15,
    max_concentration_per_sector_pct: 30,
    min_cash_reserve_pct: 10,
  },
  {
    strategy_key: "cash_secured_put",
    delta_target_min: 0.2,
    delta_target_max: 0.3,
    dte_target_min: 30,
    dte_target_max: 45,
    max_position_pct_of_portfolio: 10,
    max_aggregate_collateral_pct: 70,
    max_concentration_per_ticker_pct: 15,
    max_concentration_per_sector_pct: 30,
    min_cash_reserve_pct: 15,
  },
];

export async function up(knex: Knex): Promise<void> {
  await knex("strategy_settings").insert(seedRows);
}

export async function down(knex: Knex): Promise<void> {
  await knex("strategy_settings")
    .whereIn(
      "strategy_key",
      seedRows.map((row) => row.strategy_key),
    )
    .delete();
}
