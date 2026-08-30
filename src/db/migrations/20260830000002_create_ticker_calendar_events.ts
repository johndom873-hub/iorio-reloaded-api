import type { Knex } from "knex";

// Earnings and ex-dividend dates per ticker, sourced from TradingView's
// public scanner endpoint (see tradingviewCalendarService.ts) -- same
// no-auth "scanner.tradingview.com/global/scan" pattern already proven in
// production by menaris-admin-api's tradingview-service.js. Replaces the
// previously-blocked IBKR Wall Street Horizon lead for both PROGRESS.md
// open items (earnings-date trade-alert filtering, ex-div CC expiry
// gating) -- see PROGRESS.md, 2026-08-30.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("ticker_calendar_events", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers").onDelete("CASCADE");
    table.text("event_type").notNullable(); // 'earnings' | 'ex_dividend'
    table.date("event_date").notNullable();
    // Raw TradingView value where present -- e.g. earnings_release_time's
    // pre/post-market marker, or the dividend amount as text. Not
    // normalized since the exact enum TradingView returns isn't
    // documented; kept alongside `raw` for anything not worth its own
    // column.
    table.text("event_time");
    table.decimal("amount", 12, 4); // ex_dividend only
    table.jsonb("raw").notNullable();
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["ticker_id", "event_type", "event_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("ticker_calendar_events");
}
