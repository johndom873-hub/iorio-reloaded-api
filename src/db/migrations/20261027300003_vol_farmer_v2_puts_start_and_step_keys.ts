import type { Knex } from "knex";

// Vol Farmer v2's names, settled (Marcelo 2026-10-27): the Step is how far below the first break-even a Put is struck
// (volFarmerV2.putStrikeBelowFirstBreakEvenPct becomes stepBelowFirstBreakEvenPct), and the Call yield under which the
// Puts start is "Puts start under" (volFarmerV2.stepCallYieldPct becomes putsStartCallYieldPct). In the lab settings and
// in every session's overrides and settings snapshot.

const targets = [
  { table: "backtest_lab_settings", column: "settings" },
  { table: "backtest_sessions", column: "overrides" },
  { table: "backtest_sessions", column: "settings_snapshot" },
];

async function renameKey(knex: Knex, from: string, to: string): Promise<void> {
  for (const { table, column } of targets) {
    await knex.raw(
      `UPDATE ?? SET ?? = jsonb_set(?? #- ARRAY['volFarmerV2', ?], ARRAY['volFarmerV2', ?], ?? -> 'volFarmerV2' -> ?)
       WHERE jsonb_typeof(?? -> 'volFarmerV2') = 'object' AND jsonb_exists(?? -> 'volFarmerV2', ?)`,
      [table, column, column, from, to, column, from, column, column, from],
    );
  }
}

export async function up(knex: Knex): Promise<void> {
  await renameKey(knex, "stepCallYieldPct", "putsStartCallYieldPct");
  await renameKey(knex, "putStrikeBelowFirstBreakEvenPct", "stepBelowFirstBreakEvenPct");
}

export async function down(knex: Knex): Promise<void> {
  await renameKey(knex, "stepBelowFirstBreakEvenPct", "putStrikeBelowFirstBreakEvenPct");
  await renameKey(knex, "putsStartCallYieldPct", "stepCallYieldPct");
}
