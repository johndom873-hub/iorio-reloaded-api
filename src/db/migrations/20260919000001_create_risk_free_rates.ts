import type { Knex } from "knex";

// One row per FRED series, upserted by src/lib/riskFreeRate.ts. A table (not
// an in-process cache) so the last good rate survives web-dyno restarts and
// a FRED outage right after one — see that file's header comment.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("risk_free_rates", (table) => {
    table.text("series_id").primary();
    table.decimal("rate_percent", 8, 4).notNullable();
    table.date("observation_date").notNullable();
    table.timestamp("fetched_at", { useTz: true }).notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("risk_free_rates");
}
