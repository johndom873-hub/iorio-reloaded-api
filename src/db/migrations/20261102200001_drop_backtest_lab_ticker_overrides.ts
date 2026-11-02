import type { Knex } from "knex";

// The lab's per-ticker values were the CC + Put Ladder's (pot, share level, rungs, a fixed shock, |delta| range), retired
// with it (Marcelo 2026-11-02). Their changes stay in backtest_lab_settings_audit; past sessions keep the values they ran
// with in their own rows.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("backtest_lab_ticker_overrides");
}

/** The table comes back empty: the dropped values are in the audit only. */
export async function down(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_lab_ticker_overrides", (table) => {
    table.text("symbol").primary();
    table.decimal("pot_dollars", 14, 2);
    table.decimal("ladder_shares_pct", 6, 2);
    table.integer("ladder_rungs");
    table.decimal("ladder_shock_pct", 6, 2);
    table.decimal("min_abs_delta", 6, 4);
    table.decimal("max_abs_delta", 6, 4);
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("updated_by_user_id").references("id").inTable("users").onDelete("SET NULL");
  });
}
