import type { Knex } from "knex";

// Added after Juan repeatedly clicked "Run Now" on Trade Alerts (2026-08-31)
// with no way to tell, from job_runs alone, which rows were the nightly
// Heroku Scheduler run vs. his manual clicks — and no guard stopping those
// manual clicks from stacking multiple concurrent IBKR scans on top of each
// other and the scheduled run.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("job_runs", (table) => {
    table.enu("triggered_by", ["scheduler", "manual"], { useNative: false, enumName: "job_run_triggered_by" }).notNullable().defaultTo("scheduler");
    table.uuid("triggered_by_user_id").references("id").inTable("users");
  });

  // Belt-and-suspenders against the check-then-insert race in runJob() —
  // makes "only one running row per job_name" a DB-enforced invariant, not
  // just an application-level check.
  await knex.raw(`CREATE UNIQUE INDEX job_runs_one_running_per_job ON job_runs (job_name) WHERE status = 'running'`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP INDEX IF EXISTS job_runs_one_running_per_job");
  await knex.schema.alterTable("job_runs", (table) => {
    table.dropColumn("triggered_by_user_id");
    table.dropColumn("triggered_by");
  });
  await knex.raw("DROP TYPE IF EXISTS job_run_triggered_by");
}
