import type { Knex } from "knex";

// Resolved once per ticker via TradingView's public symbol-search endpoint
// and cached here -- avoids re-resolving (and re-hitting that endpoint) on
// every calendar-capture run. "EXCHANGE:SYMBOL" format, e.g. "NASDAQ:AAPL".
// Null until first resolved; a ticker TradingView can't find stays null
// forever (calendar capture just skips it, logged, not a hard failure).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tickers", (table) => {
    table.text("tradingview_ticker");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tickers", (table) => {
    table.dropColumn("tradingview_ticker");
  });
}
