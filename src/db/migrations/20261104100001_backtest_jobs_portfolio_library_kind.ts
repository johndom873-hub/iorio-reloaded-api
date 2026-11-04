import type { Knex } from "knex";

// The portfolio simulator's suggestions library (Marcelo 2026-11-04): every data-file ticker run alone on the projection's
// paths at six pot sizes, rebuilt as a backtest job of the new kind "portfolio_library" (portfolioLibrary.ts).
export async function up(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE backtest_jobs DROP CONSTRAINT backtest_jobs_kind_check");
  await knex.raw("ALTER TABLE backtest_jobs ADD CONSTRAINT backtest_jobs_kind_check CHECK (kind = ANY (ARRAY['download'::text, 'backtest'::text, 'analysis'::text, 'portfolio_library'::text]))");
}

export async function down(knex: Knex): Promise<void> {
  await knex("backtest_jobs").where({ kind: "portfolio_library" }).delete();
  await knex.raw("ALTER TABLE backtest_jobs DROP CONSTRAINT backtest_jobs_kind_check");
  await knex.raw("ALTER TABLE backtest_jobs ADD CONSTRAINT backtest_jobs_kind_check CHECK (kind = ANY (ARRAY['download'::text, 'backtest'::text, 'analysis'::text]))");
}
