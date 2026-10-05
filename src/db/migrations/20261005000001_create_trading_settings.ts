import type { Knex } from "knex";

// The single home for every trading limit and target (Marcelo 2026-10-05). Replaces the two overlapping tables:
// signal_settings (the limits that blocked Signals-built orders, plus the Signals filters) and strategy_settings
// (a per-strategy copy of the same limits that nothing enforced, plus the delta/DTE windows). Expand step only:
// the values are copied from what was actually in force, and the old tables stay in place, unread, until a later
// release drops them (old web dynos keep serving during a release and must not hit a missing table).
//
// Copied from: the three limits, min yield and commission warning from signal_settings (the values the order gate used);
// the delta band and the Recovery Path DTE window from the covered_call row of strategy_settings (the values the
// order review and Recovery Path used). Dropped as dead or unwanted: max_delta_drift_pct, the existing-position
// delta pair, aggregate collateral %, sector concentration %, and the unenforced strategy copies of the limits.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("trading_settings", (table) => {
    // One row, enforced by the database: id can only ever be true.
    table.boolean("id").primary().defaultTo(true);
    table.decimal("max_position_pct_of_portfolio", 5, 2).notNullable();
    table.decimal("max_concentration_per_ticker_pct", 5, 2).notNullable();
    table.decimal("min_cash_reserve_pct", 5, 2).notNullable();
    table.decimal("delta_target_min", 5, 4).notNullable();
    table.decimal("delta_target_max", 5, 4).notNullable();
    table.integer("recovery_dte_min").notNullable();
    table.integer("recovery_dte_max").notNullable();
    table.decimal("min_annualized_yield_pct", 5, 2).notNullable();
    table.decimal("commission_warn_share_of_premium_pct", 5, 2).notNullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("updated_by_user_id").references("id").inTable("users");
  });
  await knex.raw(`
    alter table trading_settings
      add constraint trading_settings_single_row check (id),
      add constraint trading_settings_percentages_in_range check (
        max_position_pct_of_portfolio between 0 and 100 and max_concentration_per_ticker_pct between 0 and 100
        and min_cash_reserve_pct between 0 and 100 and min_annualized_yield_pct between 0 and 100
        and commission_warn_share_of_premium_pct between 0 and 100),
      add constraint trading_settings_delta_band_valid check (delta_target_min >= 0 and delta_target_max <= 1 and delta_target_min <= delta_target_max),
      add constraint trading_settings_dte_window_valid check (recovery_dte_min >= 0 and recovery_dte_min <= recovery_dte_max)
  `);

  const copied = await knex.raw(`
    insert into trading_settings (
      max_position_pct_of_portfolio, max_concentration_per_ticker_pct, min_cash_reserve_pct,
      delta_target_min, delta_target_max, recovery_dte_min, recovery_dte_max,
      min_annualized_yield_pct, commission_warn_share_of_premium_pct)
    select s.max_position_pct_of_portfolio, s.max_concentration_per_ticker_pct, s.min_cash_reserve_pct,
           c.delta_target_min, c.delta_target_max, c.dte_target_min, c.dte_target_max,
           s.min_annualized_yield_pct, s.commission_warn_share_of_premium_pct
    from signal_settings s
    cross join strategy_settings c
    where c.strategy_key = 'covered_call'
    limit 1
  `);
  if (copied.rowCount !== 1) throw new Error("trading_settings was not seeded: signal_settings or the covered_call row of strategy_settings is missing.");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("trading_settings");
}
