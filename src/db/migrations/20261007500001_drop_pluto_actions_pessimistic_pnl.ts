import type { Knex } from "knex";

// The pessimistic fill figure is gone from Pluto (Marcelo, 2026-10-07: not a metric he uses). The fill-slippage breaker
// still compares each fill with the order's reference; it never read this column.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_actions", (table) => {
    table.dropColumn("pessimistic_pnl");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_actions", (table) => {
    table.decimal("pessimistic_pnl", 14, 2);
  });
}
