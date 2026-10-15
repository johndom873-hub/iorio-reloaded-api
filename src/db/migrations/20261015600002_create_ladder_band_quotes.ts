import type { Knex } from "knex";

// The CC + Put Ladder's live quotes (Marcelo 2026-10-15): the Day Signals loop quotes each ladder ticker's band (the
// contracts that can qualify, ladderRequoteBand.ts) beside Signals' own contracts, and stores them here, apart from
// day_signal_quotes, so the Signals screens score exactly what they did before. One row per contract per day, the latest
// quote; the stock price of the same cycle is kept to work out the contract's own implied volatility later.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("ladder_band_quotes", (table) => {
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers").onDelete("CASCADE");
    /** Eastern trading date. */
    table.date("trading_date").notNullable();
    table.date("expiry").notNullable();
    table.decimal("strike", 12, 4).notNullable();
    table.string("option_right", 1).notNullable();
    table.decimal("bid", 12, 4).nullable();
    table.decimal("ask", 12, 4).nullable();
    /** The ticker's live price in the same loop cycle; null when the cycle had none. */
    table.decimal("stock_price", 12, 4).nullable();
    table.integer("error_code").nullable();
    table.timestamp("quoted_at", { useTz: true }).notNullable();
    table.integer("cycle_number").notNullable();
    table.primary(["ticker_id", "trading_date", "expiry", "strike", "option_right"]);
  });
  await knex.raw("alter table ladder_band_quotes add constraint ladder_band_quotes_right_check check (option_right in ('C', 'P'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("ladder_band_quotes");
}
