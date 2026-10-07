import type { Knex } from "knex";

// Day Signals re-checks (Marcelo, 2026-10-07): the daily cap of three re-ranks becomes a 15-minute minimum gap between two
// looks at a ticker, and unpooled tickers get an hourly timed re-check. first_seen_at starts that clock; last_look_at is the
// last re-rank or re-check, last_look_kind says which ("price" or "timed").
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("day_signal_rerank_state", (table) => {
    table.timestamp("first_seen_at", { useTz: true }).nullable();
    table.timestamp("last_look_at", { useTz: true }).nullable();
    table.text("last_look_kind").nullable();
  });
  await knex.raw("ALTER TABLE day_signal_rerank_state ADD CONSTRAINT day_signal_rerank_state_last_look_kind_check CHECK (last_look_kind IS NULL OR last_look_kind IN ('price', 'timed'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE day_signal_rerank_state DROP CONSTRAINT day_signal_rerank_state_last_look_kind_check");
  await knex.schema.alterTable("day_signal_rerank_state", (table) => {
    table.dropColumn("first_seen_at");
    table.dropColumn("last_look_at");
    table.dropColumn("last_look_kind");
  });
}
