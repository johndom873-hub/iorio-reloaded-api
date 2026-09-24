import type { Knex } from "knex";

// Singleton table (always exactly one row, seeded by the next migration) —
// Signals has no per-strategy split like strategy_settings, so there's no
// natural key to keep unique on; routes read/update the sole row directly.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("signal_settings", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.decimal("max_delta_drift_pct", 5, 2).notNullable();
    table.decimal("min_annualized_yield_pct", 5, 2).notNullable();
    table.decimal("max_net_delta", 5, 4).notNullable();
    table.decimal("max_position_pct_of_portfolio", 5, 2).notNullable();
    table.decimal("max_concentration_per_ticker_pct", 5, 2).notNullable();
    table.decimal("min_cash_reserve_pct", 5, 2).notNullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("updated_by_user_id").references("id").inTable("users");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("signal_settings");
}
