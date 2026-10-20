import type { Knex } from "knex";

// A cycle's stretches become stock only (Marcelo 2026-10-20): sessions with shares held and no option open, put or call,
// where they were sessions with shares held and no call on some of them. The stretches stored under the old rule are
// cleared (null, as for sessions run before stretches were kept); a re-run records the new ones.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_cycles", (table) => {
    table.renameColumn("uncovered_stretches", "stock_only_stretches");
  });
  await knex("backtest_cycles").update({ stock_only_stretches: null });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_cycles", (table) => {
    table.renameColumn("stock_only_stretches", "uncovered_stretches");
  });
}
