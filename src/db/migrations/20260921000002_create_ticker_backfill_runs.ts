import type { Knex } from "knex";

// One row per "prepare this ticker" run (new-ticker backfill pipeline, design
// agreed 2026-09-21): the pipeline writes step-by-step progress here and the
// shortlist progress modal streams it over SSE, so progress survives closing
// the modal or refreshing the page. A ticker with a fresh 'running' row is
// "preparing" — the nightly jobs skip it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("ticker_backfill_runs", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.text("status").notNullable(); // running | complete | partial
    table.jsonb("steps").notNullable(); // [{key,label,status,message}]
    table.integer("progress_percent").notNullable().defaultTo(0);
    table.timestamp("started_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("finished_at", { useTz: true });
    table.index(["ticker_id", "started_at"]);
  });
  await knex.raw(`ALTER TABLE ticker_backfill_runs ADD CONSTRAINT ticker_backfill_runs_status_check CHECK (status IN ('running','complete','partial'))`);
  // At most one running run per ticker.
  await knex.raw(`CREATE UNIQUE INDEX ticker_backfill_runs_one_running ON ticker_backfill_runs (ticker_id) WHERE status = 'running'`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("ticker_backfill_runs");
}
