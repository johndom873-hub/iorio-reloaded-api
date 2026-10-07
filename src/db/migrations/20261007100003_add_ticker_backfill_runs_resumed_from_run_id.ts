import type { Knex } from "knex";

// The backfill queue lives in the web process, so a restart (deploy, crash) leaves its runs 'running' with nothing
// working on them. On boot the web process closes those and starts each one again; this column marks a run that is
// itself such a restart, so a run that keeps getting interrupted is restarted once, not on every boot.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("ticker_backfill_runs", (table) => {
    table.uuid("resumed_from_run_id").nullable().references("id").inTable("ticker_backfill_runs");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("ticker_backfill_runs", (table) => {
    table.dropColumn("resumed_from_run_id");
  });
}
