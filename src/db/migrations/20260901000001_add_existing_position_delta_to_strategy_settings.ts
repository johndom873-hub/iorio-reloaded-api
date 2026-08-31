import type { Knex } from "knex";

// New delta range that governs covered-call scanning specifically when the
// account already owns enough shares of the ticker to write against (see
// fetchAvailableUncoveredShares in lib/positionQueries.ts) — as opposed to
// the existing generic delta_target_min/max, which now only governs the
// buy-write/hypothetical case (no owned shares). Nullable and unused for
// cash_secured_put, which has no "existing position" concept. Default
// approved by the user 2026-09-01: same as the existing generic range.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("strategy_settings", (table) => {
    table.decimal("delta_target_min_existing_position", 5, 4);
    table.decimal("delta_target_max_existing_position", 5, 4);
  });

  await knex("strategy_settings")
    .where({ strategy_key: "covered_call" })
    .update({
      delta_target_min_existing_position: 0.2,
      delta_target_max_existing_position: 0.3,
    });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("strategy_settings", (table) => {
    table.dropColumn("delta_target_min_existing_position");
    table.dropColumn("delta_target_max_existing_position");
  });
}
