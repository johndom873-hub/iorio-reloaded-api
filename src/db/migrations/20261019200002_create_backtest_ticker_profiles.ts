import type { Knex } from "knex";

// The Analyse window's header (Marcelo 2026-10-19): each analysed ticker's full name, sector, industry and kind (stock,
// ADR, ETF) from TradingView, refreshed when its analysis runs. IBKR's own name is upper case and cut at 28 characters.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_ticker_profiles", (table) => {
    table.text("symbol").primary();
    table.text("tradingview_ticker").notNullable();
    table.text("company_name");
    table.text("sector");
    table.text("industry");
    table.text("kind").notNullable();
    table.timestamp("fetched_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw("ALTER TABLE backtest_ticker_profiles ADD CONSTRAINT backtest_ticker_profiles_kind_check CHECK (kind IN ('stock', 'adr', 'etf', 'other'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_ticker_profiles");
}
