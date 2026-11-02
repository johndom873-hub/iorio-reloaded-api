import type { Knex } from "knex";

// A ticker's own Vol Farmer v4 lab values (Marcelo 2026-11-02): five of v4's values, read by the ticker's analysis and
// prefilled on a New session of that ticker alone. A null column is the lab's value; a ticker with all five null has no
// row. Pluto never reads them. Changes are written to backtest_lab_settings_audit with the ticker's symbol.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_lab_ticker_values", (table) => {
    table.text("symbol").primary();
    table.decimal("call_min_abs_delta", 6, 4);
    table.decimal("call_max_abs_delta", 6, 4);
    table.decimal("first_position_pct", 7, 4);
    table.decimal("put_max_abs_delta", 6, 4);
    table.decimal("leaps_max_account_pct", 7, 4);
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("updated_by_user_id").references("id").inTable("users").onDelete("SET NULL");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("backtest_lab_ticker_values");
}
