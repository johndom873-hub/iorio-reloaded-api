import type { Knex } from "knex";

// The Day Signals upgrade alerts grade on the valuation model since the old 63-day Edge was retired (Marcelo 2026-10-20):
// the grades stored so far are the old ones, so they are cleared. A contract with no stored grade is a baseline on the
// loop's next re-score, never an upgrade, so nothing alerts from the switch.
export async function up(knex: Knex): Promise<void> {
  await knex("day_signal_quotes").update({ last_grade: null });
  await knex("day_signal_roll_grades").delete();
}

export async function down(): Promise<void> {
  // Nothing to restore: the loop records grades again on its next re-score.
}
