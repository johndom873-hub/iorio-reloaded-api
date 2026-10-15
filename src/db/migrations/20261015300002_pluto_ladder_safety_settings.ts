import type { Knex } from "knex";

// The CC + Put Ladder's own values for the checks kept with a value per strategy (Marcelo 2026-10-15): SPY stress 5%,
// no ticker cooldown, at most 5 open positions per ticker, at most 30 orders per ticker per day (every order sent
// counts, re-prices included). The daily-loss breaker stays one Pluto-wide value (daily_loss_breaker_pct).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    table.decimal("ladder_spy_stress_breaker_pct", 6, 2).notNullable().defaultTo(5);
    table.integer("ladder_ticker_cooldown_minutes").notNullable().defaultTo(0);
    table.integer("ladder_max_open_positions_per_ticker").notNullable().defaultTo(5);
    table.integer("ladder_max_orders_per_ticker_per_day").notNullable().defaultTo(30);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    for (const column of ["ladder_spy_stress_breaker_pct", "ladder_ticker_cooldown_minutes", "ladder_max_open_positions_per_ticker", "ladder_max_orders_per_ticker_per_day"]) table.dropColumn(column);
  });
}
