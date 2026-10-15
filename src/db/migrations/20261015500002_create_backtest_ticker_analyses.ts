import type { Knex } from "knex";

// The Analyse window's stored analyses (Marcelo 2026-10-15): one row per computation of a ticker, kept as history; the
// window opens the latest succeeded one. Each records the lab values it was computed with, so a save of the ticker's or
// the global lab values can re-run it, and the backtest session it ran (an ordinary session, visible in Sessions). The
// work runs as a backtest job of the new kind "analysis".
export async function up(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE backtest_jobs DROP CONSTRAINT backtest_jobs_kind_check");
  await knex.raw("ALTER TABLE backtest_jobs ADD CONSTRAINT backtest_jobs_kind_check CHECK (kind = ANY (ARRAY['download'::text, 'backtest'::text, 'analysis'::text]))");

  await knex.schema.createTable("backtest_ticker_analyses", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("symbol").notNullable();
    table.uuid("job_id").references("id").inTable("backtest_jobs").onDelete("SET NULL");
    table.text("status").notNullable().defaultTo("queued").checkIn(["queued", "running", "succeeded", "failed", "cancelled"]);
    /** Bumped when a formula or the figures' shape changes: older rows show as computed with older formulas. */
    table.integer("formulas_version").notNullable();
    /** The ticker's lab values the analysis used: { settings (BacktestSettings), potDollars, tickerValues }. */
    table.jsonb("lab_values").notNullable();
    /** A hash of lab_values: a stored analysis whose hash differs from the current values is out of date. */
    table.text("lab_values_hash").notNullable();
    /** What the data file held: { completeDays, lastOptionDate, barCount, lastBarDate }. */
    table.jsonb("file_fingerprint");
    table.date("option_last_date");
    table.date("bars_last_date");
    /** The analysis's own backtest session (an ordinary session). */
    table.uuid("session_id").references("id").inTable("backtest_sessions").onDelete("SET NULL");
    table.jsonb("figures");
    table.decimal("figures_seconds", 10, 2);
    table.text("summary_status").notNullable().defaultTo("pending").checkIn(["pending", "written", "not_configured", "usage_limit", "failed", "skipped"]);
    /** { headline, paragraphs[], dataCaveats[], recommendation: { verdict, reason, values[] } }. */
    table.jsonb("summary");
    table.text("summary_model");
    table.integer("summary_prompt_version");
    table.integer("summary_tokens_in");
    table.integer("summary_tokens_out");
    table.decimal("summary_cost_usd", 10, 4);
    table.integer("summary_latency_ms");
    table.text("summary_raw_output");
    table.text("summary_error");
    table.text("error");
    /** The save that started it: "manual", "ticker_settings" or "global_settings". */
    table.text("reason").notNullable().defaultTo("manual");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("finished_at", { useTz: true });
    table.index(["symbol", "created_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_ticker_analyses");
  await knex.raw("DELETE FROM backtest_jobs WHERE kind = 'analysis'");
  await knex.raw("ALTER TABLE backtest_jobs DROP CONSTRAINT backtest_jobs_kind_check");
  await knex.raw("ALTER TABLE backtest_jobs ADD CONSTRAINT backtest_jobs_kind_check CHECK (kind = ANY (ARRAY['download'::text, 'backtest'::text]))");
}
