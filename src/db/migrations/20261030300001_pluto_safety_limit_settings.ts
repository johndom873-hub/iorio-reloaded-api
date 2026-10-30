import type { Knex } from "knex";

// The caps, SPY stress breaker and ticker cooldown hold every Pluto strategy, not only the CC + Put Ladder (Marcelo
// 2026-10-30): their columns take the Safety Limits' name.
const renamedColumns: [string, string][] = [
  ["ladder_max_working_orders_per_ticker", "safety_max_working_orders_per_ticker"],
  ["ladder_max_open_positions_per_ticker", "safety_max_open_positions_per_ticker"],
  ["ladder_max_orders_per_ticker_per_day", "safety_max_orders_per_ticker_per_day"],
  ["ladder_max_open_positions", "safety_max_open_positions"],
  ["ladder_max_orders_per_day", "safety_max_orders_per_day"],
  ["ladder_spy_stress_breaker_pct", "safety_spy_stress_breaker_pct"],
  ["ladder_ticker_cooldown_minutes", "safety_ticker_cooldown_minutes"],
];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    for (const [from, to] of renamedColumns) table.renameColumn(from, to);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    for (const [from, to] of renamedColumns) table.renameColumn(to, from);
  });
}
