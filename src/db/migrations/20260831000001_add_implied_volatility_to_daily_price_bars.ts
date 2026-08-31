import type { Knex } from "knex";

// One IBKR OPTION_IMPLIED_VOLATILITY value per (ticker, trading_date) —
// IBKR's own blended implied volatility for the underlying's option chain,
// same historical-bar shape as the existing OHLCV columns (one number per
// day, not per strike/expiry). Nullable: existing rows and any day the
// backfill/daily job couldn't fetch it stay null rather than blocking the
// price data those rows already carry. Feeds IV Percentile (approved
// 2026-08-31 — see PROGRESS.md).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("daily_price_bars", (table) => {
    table.decimal("implied_volatility", 10, 6);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("daily_price_bars", (table) => {
    table.dropColumn("implied_volatility");
  });
}
