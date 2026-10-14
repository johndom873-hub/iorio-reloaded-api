import type { Knex } from "knex";

// A run that finished its work but had errors on part of it (one ticker without IV out of 26) is
// "completed_with_errors", not "failure": failure is kept for runs that produced nothing usable.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`alter table job_runs drop constraint job_runs_status_check`);
  await knex.raw(`alter table job_runs add constraint job_runs_status_check check (status in ('running', 'success', 'failure', 'completed_with_errors'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`update job_runs set status = 'failure' where status = 'completed_with_errors'`);
  await knex.raw(`alter table job_runs drop constraint job_runs_status_check`);
  await knex.raw(`alter table job_runs add constraint job_runs_status_check check (status in ('running', 'success', 'failure'))`);
}
