import type { Knex } from "knex";

// Defaults approved by Marcelo 2026-09-24, deliberately independent from
// strategy_settings' own max-position/concentration/cash-reserve fields
// (Signals and Trade Alerts each keep their own copies of these concepts).
const seedRow = {
  max_delta_drift_pct: 10,
  min_annualized_yield_pct: 50,
  max_net_delta: 0.4,
  max_position_pct_of_portfolio: 10,
  max_concentration_per_ticker_pct: 20,
  min_cash_reserve_pct: 5,
};

export async function up(knex: Knex): Promise<void> {
  await knex("signal_settings").insert(seedRow);
}

export async function down(knex: Knex): Promise<void> {
  await knex("signal_settings").where(seedRow).delete();
}
