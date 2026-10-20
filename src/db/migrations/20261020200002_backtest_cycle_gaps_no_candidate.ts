import type { Knex } from "knex";

// Why no contract qualified on a gap's days (Marcelo 2026-10-20, recorded only): each check's rule and what it left out,
// for the Wheel cycles' tooltip. Null for gaps stored before it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_cycle_gaps", (table) => {
    /** BacktestNoCandidateDetail, or null. */
    table.jsonb("no_candidate").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_cycle_gaps", (table) => {
    table.dropColumn("no_candidate");
  });
}
