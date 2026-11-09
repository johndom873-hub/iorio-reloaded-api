import type { Knex } from "knex";

// Automatic retries of a ticker's option chain and 5-year daily history (Marcelo 2026-11-09): one row per ticker, kind and
// Eastern trading day, counting the tries the retry pass made (src/ibkr/tickerDataRetries.ts). A history row that succeeded
// also counts as the history being complete (dailyBarsStatus.ts).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("ticker_data_retries", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers").onDelete("CASCADE");
    table.text("data_kind").notNullable();
    table.date("trading_date").notNullable();
    table.integer("attempts").notNullable().defaultTo(0);
    table.text("last_error");
    table.timestamp("last_attempt_at", { useTz: true });
    table.timestamp("succeeded_at", { useTz: true });
    table.timestamp("gave_up_at", { useTz: true });
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["ticker_id", "data_kind", "trading_date"]);
  });
  await knex.raw(`ALTER TABLE ticker_data_retries ADD CONSTRAINT ticker_data_retries_data_kind_check CHECK (data_kind IN ('option_chain', 'daily_bars_history'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("ticker_data_retries");
}
