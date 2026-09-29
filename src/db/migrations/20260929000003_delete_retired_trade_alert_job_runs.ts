import type { Knex } from "knex";

// The Trade Alerts job is retired; its run history would otherwise keep a
// stale status card on System Health forever. down() cannot restore the rows.
export async function up(knex: Knex): Promise<void> {
  await knex("job_runs").where({ job_name: "trade_alert_generation" }).delete();
}

export async function down(): Promise<void> {}
