import type { Knex } from "knex";

// Model review (approved by Marcelo 2026-10-10): the Day Signals seed picks its pool by the valuation model, so the
// figures it records for each pooled expiry are the model's (expected P&L per contract, edge margin), not the old Edge's.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("day_signal_expiries", (table) => {
    table.renameColumn("seed_best_edge_dollars", "seed_best_expected_pnl_dollars");
    table.renameColumn("seed_best_net_edge", "seed_best_edge_margin");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("day_signal_expiries", (table) => {
    table.renameColumn("seed_best_expected_pnl_dollars", "seed_best_edge_dollars");
    table.renameColumn("seed_best_edge_margin", "seed_best_net_edge");
  });
}
