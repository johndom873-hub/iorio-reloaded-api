import type { Knex } from "knex";

// NYSE trading-day calendar, sourced from MarketData.app's market-status
// endpoint (see scripts/sync-market-calendar.ts) -- lets Day P&L anchor on
// the actual last trading day instead of literal CURRENT_DATE - 1, which
// would wrongly treat a market holiday as a trading day (PROGRESS.md,
// 2026-09-01: fixes the WTD-shows-$0-while-Day-doesn't-bug root cause).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("market_calendar", (table) => {
    table.date("calendar_date").primary();
    table.boolean("is_open").notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("market_calendar");
}
