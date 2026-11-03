import type { Knex } from "knex";

// strategy_settings has had no reader since trading_settings took over its limits and delta band (20261005000001) and the
// Trade Alerts / Recovery Path code that read it went; only a schema test touched it. down() recreates the schema only
// (from the dev database's pg_dump, 2026-11-03); the dropped rows do not come back.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTable("strategy_settings");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`CREATE TABLE strategy_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    strategy_key text NOT NULL,
    delta_target_min numeric(5,4),
    delta_target_max numeric(5,4),
    dte_target_min integer,
    dte_target_max integer,
    max_position_pct_of_portfolio numeric(5,2),
    max_aggregate_collateral_pct numeric(5,2),
    max_concentration_per_ticker_pct numeric(5,2),
    max_concentration_per_sector_pct numeric(5,2),
    min_cash_reserve_pct numeric(5,2),
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by_user_id uuid,
    delta_target_min_existing_position numeric(5,4),
    delta_target_max_existing_position numeric(5,4),
    CONSTRAINT strategy_settings_pkey PRIMARY KEY (id),
    CONSTRAINT strategy_settings_strategy_key_unique UNIQUE (strategy_key),
    CONSTRAINT strategy_settings_updated_by_user_id_foreign FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
  )`);
}
