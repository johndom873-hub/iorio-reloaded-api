import type { Knex } from "knex";

// The CC + Put Ladder retired from Pluto (Marcelo 2026-11-02): Pluto runs Vol Farmer v4 on every ticker. Its memory per
// ticker, its strategy-wide values, each ticker's own values and the per-ticker strategy choice go; their changes stay in
// pluto_settings_audit and pluto_ticker_settings_audit, and past actions keep their execution_strategy.

const settingsColumns: [name: string, kind: "integer" | "decimal", precision: number, scale: number, defaultValue: number][] = [
  ["ladder_min_abs_delta", "decimal", 6, 4, 0.05],
  ["ladder_max_abs_delta", "decimal", 6, 4, 0.3],
  ["ladder_min_dte", "integer", 0, 0, 1],
  ["ladder_max_dte", "integer", 0, 0, 45],
  ["ladder_max_spread_pct_of_mid", "decimal", 6, 2, 50],
  ["ladder_rungs", "integer", 0, 0, 5],
  ["ladder_shares_pct", "decimal", 6, 2, 50],
  ["ladder_shock_min_pct", "decimal", 6, 2, 60],
  ["ladder_shock_max_pct", "decimal", 6, 2, 80],
  ["ladder_shock_no_history_pct", "decimal", 6, 2, 90],
  ["ladder_shock_lookback_years", "integer", 0, 0, 10],
];

const tickerColumns: [name: string, kind: "integer" | "decimal", precision: number, scale: number][] = [
  ["ladder_shares_pct", "decimal", 6, 2],
  ["ladder_shock_override_pct", "decimal", 6, 2],
  ["ladder_rungs", "integer", 0, 0],
  ["ladder_min_abs_delta", "decimal", 6, 4],
  ["ladder_max_abs_delta", "decimal", 6, 4],
];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("pluto_ladder_cycles");
  await knex.raw("alter table pluto_ticker_settings drop constraint if exists pluto_ticker_settings_strategy_check");
  await knex.schema.alterTable("pluto_ticker_settings", (table) => {
    table.dropColumn("strategy");
    for (const [name] of tickerColumns) table.dropColumn(name);
  });
  await knex.schema.alterTable("pluto_settings", (table) => {
    for (const [name] of settingsColumns) table.dropColumn(name);
  });
}

/** The columns come back at their defaults and the tickers' values empty: the dropped values are in the audits only. */
export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    for (const [name, kind, precision, scale, defaultValue] of settingsColumns) (kind === "integer" ? table.integer(name) : table.decimal(name, precision, scale)).notNullable().defaultTo(defaultValue);
  });
  await knex.schema.alterTable("pluto_ticker_settings", (table) => {
    table.text("strategy").nullable();
    for (const [name, kind, precision, scale] of tickerColumns) (kind === "integer" ? table.integer(name) : table.decimal(name, precision, scale)).nullable();
  });
  await knex.raw("alter table pluto_ticker_settings add constraint pluto_ticker_settings_strategy_check check (strategy is null or strategy in ('vol_farmer_v4', 'cc_put_ladder'))");
  await knex.schema.createTable("pluto_ladder_cycles", (table) => {
    table.uuid("ticker_id").primary().references("id").inTable("tickers").onDelete("CASCADE");
    table.date("cycle_started_on").nullable();
    table.decimal("account_value_at_start", 16, 2).notNullable();
    table.decimal("shock_fraction", 8, 6).nullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}
