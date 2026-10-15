import type { Knex } from "knex";

// Stock splits as detected in IBKR's daily history (dailyBarSplitCheck.ts), one row per ticker and effective date
// (Marcelo 2026-10-15). A split with records_rewritten_at null is pending: the platform's own records (positions, legs,
// trades) are still on the old basis, so the CC + Put Ladder stops trading the ticker and its working orders are
// cancelled until the rewrite to post-split terms has run.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("stock_splits", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers").onDelete("CASCADE");
    /** New shares per old share: 2 for a 2-for-1 split, 0.1 for a 1-for-10 reverse split (stored price ÷ IBKR's adjusted price). */
    table.decimal("ratio", 14, 8).notNullable();
    /** The first trading day on the new basis (Eastern date). */
    table.date("effective_date").notNullable();
    table.timestamp("detected_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    /** When the platform's own records were rewritten to the new basis; null while pending. */
    table.timestamp("records_rewritten_at", { useTz: true }).nullable();
    table.unique(["ticker_id", "effective_date"]);
  });
  await knex.raw("alter table stock_splits add constraint stock_splits_ratio_check check (ratio > 0)");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("stock_splits");
}
