import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("job_runs", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("job_name").notNullable();
    table.timestamp("started_at", { useTz: true }).notNullable();
    table.timestamp("finished_at", { useTz: true });
    table.enu("status", ["running", "success", "failure"], { useNative: false }).notNullable();
    table.text("error_message");
    table.jsonb("details");

    // Supports "most recent run for this job" lookups used by both the
    // state-transition alerting logic and the watchdog's liveness checks.
    table.index(["job_name", "started_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("job_runs");
}
