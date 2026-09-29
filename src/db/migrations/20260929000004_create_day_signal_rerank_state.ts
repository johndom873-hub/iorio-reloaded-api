import type { Knex } from "knex";

// Day Signals re-rank bookkeeping (approved 2026-09-29), one row per ticker per trading day: the spot at the
// ticker's last expiry re-rank (null-equivalent = the 9:30 capture spot, i.e. no row) and how many re-ranks ran
// today, so a loop restart neither repeats a re-rank nor resets the daily cap. Wiped with the rest of the day's
// pool by the seed step (replaceDaySignalPool).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("day_signal_rerank_state", (table) => {
    table.uuid("ticker_id").notNullable().primary().references("id").inTable("tickers");
    table.date("trading_date").notNullable();
    table.decimal("reference_spot_price", 14, 4).notNullable();
    table.integer("rerank_count").notNullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("day_signal_rerank_state");
}
