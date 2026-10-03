import type { Knex } from "knex";

// A snapshot is "analysed" once the surface fit has finished with it, whether or not it produced a usable surface
// (approved 2026-10-03): the Signals screen shows "Analysing" until then, and a finished fit that left nothing usable
// as an issue with its reason. fit_issue holds the reason when the fit skipped the snapshot or errored.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("option_chain_snapshots", (table) => {
    table.timestamp("fit_completed_at", { useTz: true }).nullable();
    table.text("fit_issue").nullable();
  });
  // Every snapshot that exists today was analysed by the fit job that ran after its capture (or never will be): not pending.
  await knex.raw(`
    UPDATE option_chain_snapshots s
    SET fit_completed_at = COALESCE((SELECT max(f.fitted_at) FROM option_surface_fits f WHERE f.snapshot_id = s.id), s.captured_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("option_chain_snapshots", (table) => {
    table.dropColumn("fit_issue");
    table.dropColumn("fit_completed_at");
  });
}
