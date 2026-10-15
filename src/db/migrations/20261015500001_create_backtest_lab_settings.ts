import type { Knex } from "knex";

// The backtesting lab's own settings (Marcelo 2026-10-15): separate from Pluto's live settings and never synced with
// them. One global row, seeded on first read as a copy of the New session snapshot of that moment, then edited on the
// Backtesting screen; each ticker's lab values (pot, share level, rungs, a fixed shock, |delta| range) saved from its
// Analyse window; and one audit row per changed value.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_lab_settings", (table) => {
    table.smallint("id").primary();
    /** A full BacktestSettings: pluto, trading, kellyFraction, policy, decisionMaker, model, baseline. */
    table.jsonb("settings").notNullable();
    /** The dollars each ticker starts with when it has no pot of its own. */
    table.decimal("default_pot_dollars", 14, 2).notNullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("updated_by_user_id").references("id").inTable("users").onDelete("SET NULL");
  });
  await knex.raw("ALTER TABLE backtest_lab_settings ADD CONSTRAINT backtest_lab_settings_single_row CHECK (id = 1)");

  await knex.schema.createTable("backtest_lab_ticker_overrides", (table) => {
    table.text("symbol").primary();
    /** Each null: the lab's global value. */
    table.decimal("pot_dollars", 14, 2);
    table.decimal("ladder_shares_pct", 6, 2);
    table.integer("ladder_rungs");
    /** A fixed shock for this ticker instead of the global shock rule. */
    table.decimal("ladder_shock_pct", 6, 2);
    table.decimal("min_abs_delta", 6, 4);
    table.decimal("max_abs_delta", 6, 4);
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("updated_by_user_id").references("id").inTable("users").onDelete("SET NULL");
  });

  await knex.schema.createTable("backtest_lab_settings_audit", (table) => {
    table.bigIncrements("id").primary();
    table.timestamp("changed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("user_id").references("id").inTable("users").onDelete("SET NULL");
    /** Null for a global value; the ticker for its own value. */
    table.text("symbol");
    /** A settings path ("baseline.ladderRungs", "lab.defaultPotDollars") or a ticker value ("potDollars", "ladderShockPct"). */
    table.text("field").notNullable();
    table.text("old_value");
    table.text("new_value");
    table.index(["changed_at"]);
    table.index(["symbol", "changed_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_lab_settings_audit");
  await knex.schema.dropTable("backtest_lab_ticker_overrides");
  await knex.schema.dropTable("backtest_lab_settings");
}
